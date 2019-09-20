import {
  reduce,
  forEach,
  isFunction
} from 'lodash';
import NodeCache from 'node-cache';
import {
  globalIdField,
  connectionArgs,
  connectionDefinitions,
  nodeDefinitions
} from 'graphql-relay';
import {
  GraphQLInt,
  GraphQLString,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  isInputObjectType,
  isScalarType
} from 'graphql/type';
import { addHooks } from '../utils';
import GraphQLDate from './custom/date';
import GraphQLBuffer from './custom/buffer';
import GraphQLGeneric from './custom/generic';
import { connectionFromModel, getOneResolver } from '../query';

const debug = require('debug')('graffiti-mongoose:type');

const typeCache = new NodeCache({
  stdTTL: process.env.GQL_TYPE_TIMEOUT || 60 * 60, // 1h
  useClones: false,
});

let CID = 0;

// $or Joins query clauses with a logical OR returns all documents that match the conditions of either clause.
// $and Joins query clauses with a logical AND returns all documents that match the conditions of both clauses.
// $not Inverts the effect of a query expression and returns documents that do not match the query expression.
// $nor Joins query clauses with a logical NOR returns all documents that fail to match both clauses.
const GraphQLLogical = new GraphQLEnumType({
  name: 'op',
  values: {
    and: {
      value: 'and'
    },
    or: {
      value: 'or'
    },
    not: {
      value: 'not'
    },
    nor: {
      value: 'nor'
    }
  }
});

const GraphQLSort = new GraphQLEnumType({
  name: 'sort',
  values: {
    desc: {
      value: -1
    },
    asc: {
      value: 1
    }
  }
});

function createTypeContext(cache = typeCache) {
  const cid = CID += 1;
  debug('type context #%s', cid);

  // Registered types will be saved, we can access them later to resolve types
  const types = [];

  /**
   * Add new type
   * @param {String} name
   * @param {GraphQLType} type
   */
  function addType(name, type) {
    debug('+', name, type);
    types[name] = type;
  }

  // Node interface
  const { nodeInterface } = nodeDefinitions(null, (obj) => (
    // Type resolver
    obj._type ? types[obj._type] : null
  ));

  // GraphQL Viewer type
  const GraphQLViewer = new GraphQLObjectType({
    name: 'Viewer',
    interfaces: [nodeInterface]
  });


  const orderByTypes = {};
  const inputByTypes = {};

  // Register Viewer type
  addType('Viewer', GraphQLViewer);

  /**
   * Returns a GraphQL type based on a String representation
   * @param  {String} type
   * @return {GraphQLType}
   */
  function stringToGraphQLType(type) {
    switch (type) {
      case 'String':
        return GraphQLString;
      case 'Number':
        return GraphQLFloat;
      case 'Date':
        return GraphQLDate;
      case 'Buffer':
        return GraphQLBuffer;
      case 'Boolean':
        return GraphQLBoolean;
      case 'ObjectID':
        return GraphQLID;
      default:
        return GraphQLGeneric;
    }
  }

  /**
   * Returns a GraphQL Enum type based on a List of Strings
   * @param  {Array} list
   * @param  {String} name
   * @return {Object}
   */
  function listToGraphQLEnumType(list, name) {
    const values = reduce(list, (values, val) => {
      values[val] = { value: val };
      return values;
    }, {});
    return new GraphQLEnumType({ name, values });
  }

  /**
   * Extracts the fields of a GraphQL type
   * @param  {GraphQLType} type
   * @return {Object}
   */
  function getTypeFields(type) {
    const fields = type._typeConfig.fields;
    return isFunction(fields) ? fields() : fields;
  }

  /**
   * Assign fields to a GraphQL type
   * @param {GraphQLType} type
   * @param {Object} fields
   */
  function setTypeFields(type, fields) {
    type._typeConfig.fields = () => fields;
  }

  /**
   * Returns order by GraphQLEnumType for fields
   * @param  {{String}} {name}
   * @param  {Object} fields
   * @return {GraphQLEnumType}
   */
  function getOrderByType({ name }, fields) {
    if (!orderByTypes[name]) {
      // save new enum
      orderByTypes[name] = new GraphQLEnumType({
        name: `orderBy${name}`,
        values: reduce(fields, (values, field) => {
          if (field.type instanceof GraphQLScalarType) {
            const upperCaseName = field.name.toUpperCase();
            values[`${upperCaseName}_ASC`] = {
              name: `${upperCaseName}_ASC`,
              value: {
                [field.name]: 1
              }
            };
            values[`${upperCaseName}_DESC`] = {
              name: `${upperCaseName}_DESC`,
              value: {
                [field.name]: -1
              }
            };
          }

          return values;
        }, {})
      });
    }
    return orderByTypes[name];
  }

  function createInputObject(type) {
    if (type instanceof GraphQLNonNull) {
      type = type.ofType;
    }
    if (isInputObjectType(type) || isScalarType(type)) {
      return type;
    }
    const { name } = type;
    if (!inputByTypes[name]) {
      const fields = getTypeFields(type);
      debug('create input', name);
      inputByTypes[name] = new GraphQLInputObjectType({
        name: `inputFor${name}`,
        fields: reduce(fields, (inputs, field) => ({
          ...inputs,
          [field.name]: { type: createInputObject(field.type) }
        }), {})
      });
      // debug(getTypeFields(inputByTypes[name]));
    }
    return inputByTypes[name];
  }

  /**
   * Returns query arguments for a GraphQL type
   * @param  {GraphQLType} type
   * @param  {Object} args
   * @return {Object}
   */
  function getArguments(type, args = {}) {
    // 字段里添加过滤条件和排序会导致字段必须显示才能过滤和排序
    // 只排序不显示的字段就需要在type上添加参数
    const fields = getTypeFields(type);

    return reduce(fields, (args, field) => {
      if (field.name === '_id' || field.name === 'id') {
        return args;
      }

      // Extract non null fields, those are not required in the arguments
      if (field.type instanceof GraphQLNonNull) {
        field.type = field.type.ofType;
      }

      if (field.type instanceof GraphQLScalarType) {
        // TODO 增加比较符
        // $eq    Matches values that are equal to a specified value.
        // $gt    Matches values that are greater than a specified value.
        // $gte    Matches values that are greater than or equal to a specified value.
        // $lt    Matches values that are less than a specified value.
        // $lte    Matches values that are less than or equal to a specified value.
        // $ne    Matches all values that are not equal to a specified value.
        // $in    Matches any of the values specified in an array.
        // $nin    Matches none of the values specified in an array.
        args[field.name] = field;
      }

      // TODO 增加对象和数组的过滤

      return args;
    }, {
      ...args,
      // TODO 排序需要增加多个字段排序
      sort: {
        name: 'sort',
        type: getOrderByType(type, fields)
      }
    });
  }

  /**
   * Returns query arguments for a field
   * @param  {Object} field
   * @param  {Object} args
   * @return {Object}
   */
  function getFieldArguments(field, args = {}) {
    // 字段参数是一种便捷的过滤和排序写法，只需要标注在每个字段上即可
    if (field.name === '_id' || field.name === 'id') {
      return args;
    }

    let type = field.type;
    // Extract non null fields, those are not required in the arguments
    if (type instanceof GraphQLNonNull) {
      type = type.ofType;
    }

    if (type instanceof GraphQLScalarType || type instanceof GraphQLEnumType) {
      args = {
        ...args,
        eq: {
          name: 'eq',
          type,
          description: 'Matches values that are equal to a specified value.'
        },
        gt: {
          name: 'gt',
          type,
          description: 'Matches values that are greater than a specified value.'
        },
        gte: {
          name: 'gte',
          type,
          description: 'Matches values that are greater than or equal to a specified value.'
        },
        lt: {
          name: 'lt',
          type,
          description: 'Matches values that are less than a specified value.'
        },
        lte: {
          name: 'lte',
          type,
          description: 'Matches values that are less than or equal to a specified value.'
        },
        ne: {
          name: 'ne',
          type,
          description: 'Matches all values that are not equal to a specified value.'
        },
        in: {
          name: 'in',
          type: new GraphQLList(type),
          description: 'Matches any of the values specified in an array.'
        },
        nin: {
          name: 'nin',
          type: new GraphQLList(type),
          description: 'Matches none of the values specified in an array.'
        },
        op: {
          name: 'op',
          type: GraphQLLogical,
          description: 'Logical relations among multiple matches.'
        },
      };

      args = {
        ...args,
        sort: {
          name: 'sort',
          type: GraphQLSort,
          description: 'A document that defines the sort order of the result set.'
        },
        sortOrder: {
          name: 'sortOrder',
          type: GraphQLInt,
          description: 'Sort order from small to large execution.'
        },
      };
    }

    if (type instanceof GraphQLList) {
      args = {
        ...args,
        all: {
          name: 'all',
          type: new GraphQLList(createInputObject(type.ofType)),
          description: 'Matches arrays that contain all elements specified in the query.'
        },
        size: {
          name: 'size',
          type: GraphQLInt,
          description: 'Selects documents if the array field is a specified size.'
        }
      };
      if (type instanceof GraphQLObjectType) {
        // 引用的对象不能过滤
        args = {
          ...args,
          elemMatch: {
            name: 'elemMatch',
            type: createInputObject(type.ofType),
            description:
            'Selects documents if element in the array field matches all the specified $elemMatch conditions.'
          }
        };
      }
    }

    return args;
  }

  /**
   * Returns a concatenation of type and field name, used for nestedObjects
   * @param {String} typeName
   * @param {String} fieldName
   * @returns {String}
   */
  function getTypeFieldName(typeName, fieldName) {
    const fieldNameCapitalized = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    return `${typeName}${fieldNameCapitalized}`;
  }

  // Holds references to fields that later have to be resolved
  const resolveReference = {};

  /**
   * Returns GraphQLType for a graffiti model
   * @param  {Object} graffitiModels
   * @param  {{String, String, Object}} {name, description, fields}
   * @param  {Boolean} root
   * @return {GraphQLObjectType}
   */
  function getType(graffitiModels, { name, description, fields }, path = [], rootType = null) {
    const root = path.length === 0;
    const graphQLType = { name, description };
    rootType = rootType || graphQLType;

    // These references have to be resolved when all type definitions are avaiable
    resolveReference[graphQLType.name] = resolveReference[graphQLType.name] || {};
    const graphQLTypeFields = reduce(fields, (graphQLFields,
        { name, description, type, subtype, reference, nonNull, hidden, hooks,
         fields: subfields, embeddedModel, enumValues }, key) => {
      name = name || key;
      const newPath = [...path, name];

      // Don't add hidden fields to the GraphQLObjectType
      if (hidden || name.startsWith('__')) {
        return graphQLFields;
      }

      const graphQLField = { name, description };

      if (type === 'Array') {
        if (subtype === 'Object') {
          const fields = subfields;
          const nestedObjectName = getTypeFieldName(graphQLType.name, name);
          graphQLField.type = new GraphQLList(
            getType(graffitiModels, { name: nestedObjectName, description, fields }, newPath, rootType));
        } else {
          graphQLField.type = new GraphQLList(stringToGraphQLType(subtype));
          if (reference) {
            resolveReference[rootType.name][name] = {
              name,
              type: reference,
              args: connectionArgs,
              resolve: addHooks((rootValue, args, context, info) => {
                args.id = rootValue[name].map((i) => i.toString());
                return connectionFromModel(graffitiModels[reference], args, context, info);
              }, hooks)
            };
          }
        }
      } else if (type === 'Object') {
        const fields = subfields;
        const nestedObjectName = getTypeFieldName(graphQLType.name, name);
        graphQLField.type = getType(graffitiModels, { name: nestedObjectName, description, fields }, newPath, rootType);
      } else if (type === 'Embedded') {
        const type = types.hasOwnProperty(name)
          ? types[name]
          : getType(graffitiModels, embeddedModel, ['embedded']);
        type.mongooseEmbedded = true;
        graphQLField.type = type;
      } else if (enumValues && type === 'String') {
        graphQLField.type = listToGraphQLEnumType(enumValues, getTypeFieldName(graphQLType.name, `${name}Enum`));
      } else {
        graphQLField.type = stringToGraphQLType(type);
      }

      if (reference && (graphQLField.type === GraphQLID || graphQLField.type === new GraphQLNonNull(GraphQLID))) {
        resolveReference[rootType.name][newPath.join('.')] = {
          name,
          type: reference,
          resolve: addHooks((rootValue, args, context, info) => {
            const resolver = getOneResolver(graffitiModels[reference]);
            return resolver(rootValue, { id: rootValue[name] ? rootValue[name].toString() : null }, context, info);
          }, hooks)
        };
      }

      if (nonNull && graphQLField.type) {
        graphQLField.type = new GraphQLNonNull(graphQLField.type);
      }

      if (!graphQLField.resolve) {
        graphQLField.resolve = addHooks((source) => source[name], hooks);
      }

      // 查询改到字段参数上
      graphQLField.args = getFieldArguments(graphQLField);

      graphQLFields[name] = graphQLField;
      // debug('create graphQLField', name, graphQLField);
      return graphQLFields;
    }, {});

    if (root) {
      // Implement the Node interface
      graphQLType.interfaces = [nodeInterface];
      graphQLTypeFields.id = globalIdField(name, (obj) => (fields.id ? obj.id : obj._id));
    }

    // Add fields to the GraphQL type
    graphQLType.fields = () => graphQLTypeFields;

    // Define type
    const GraphQLObjectTypeDefinition = new GraphQLObjectType(graphQLType);

    // Register type
    if (root) {
      addType(name, GraphQLObjectTypeDefinition);
    }

    return GraphQLObjectTypeDefinition;
  }

  function getTypes(graffitiModels) {
    debug('context #%s', cid);
    const reResolveTypes = [];

    const types = reduce(graffitiModels, (types, model) => {
      // 如果有缓存走缓存
      let type;
      if (cache) {
        type = cache.get(model.key);
        if (!type) {
          type = getType(graffitiModels, model);
          cache.set(model.key, type);
          debug('create', type);
        } else {
          // Node 不能共用有作用范围限制
          if (type._typeConfig.interfaces[0] !== nodeInterface) {
            // 所以这里重建了root的type
            const graphQLType = { ...type._typeConfig };
            graphQLType.interfaces = [nodeInterface];
            type = new GraphQLObjectType(graphQLType);
            reResolveTypes.push(type.name);
            addType(model.name, type);
            debug('recreate', type);
          } else {
            // addType(model.name, type);
            debug('cache', type);
          }
          cache.ttl(model.key);
        }
      } else {
        type = getType(graffitiModels, model);
        debug('create', type);
      }
      types[model.name] = type;
      return types;
    }, {});

    // Resolve references, all types are defined / avaiable
    forEach(resolveReference, (fields, typeName) => {
      // 缓存不处理引用
      if (reResolveTypes.indexOf(typeName) > -1) {
        return;
      }
      const type = types[typeName];
      if (type) {
        const typeFields = reduce(fields, (typeFields, field, fieldName) => {
          if (field.args === connectionArgs) {
            // It's a connection
            const connectionName = getTypeFieldName(typeName, fieldName);
            const { connectionType } = connectionDefinitions({
              name: connectionName,
              nodeType: types[field.type],
              connectionFields: {
                count: {
                  name: 'count',
                  type: GraphQLFloat
                }
              }
            });
            field.type = connectionType;
          } else {
            // It's an object reference
            field.type = types[field.type];
          }

          // deeply find the path of the field we want to resolve the reference of
          const path = fieldName.split('.');

          path.reduce((parent, segment, idx) => {
            // debug(parent[segment]);
            if (parent[segment]) {
              if (parent[segment].type instanceof GraphQLObjectType) {
                parent = getTypeFields(parent[segment].type);
              } else if (parent[segment].type instanceof GraphQLList &&
                 parent[segment].type.ofType instanceof GraphQLObjectType) {
                parent = getTypeFields(parent[segment].type.ofType);
              }
            }

            if (idx === path.length - 1) {
              parent[segment] = field;
            }

            return parent;
          }, typeFields);

          debug('resolve reference filed...', field);
          return typeFields;
        }, getTypeFields(type));

        // Add new fields
        setTypeFields(type, typeFields);
      }
    });

    return types;
  }

  return {
    GraphQLViewer,
    GraphQLDate,
    GraphQLGeneric,
    getType,
    getTypes,
    addType,
    nodeInterface,
    getTypeFields,
    setTypeFields,
    getArguments
  };
}

export default {
  typeCache,
  createTypeContext
};
