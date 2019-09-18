import { reduce, isArray, isFunction, mapValues } from 'lodash';
import { Inflectors } from 'en-inflectors';
import stringHash from 'string-hash';
import NodeCache from 'node-cache';
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLBoolean,
  GraphQLFloat
} from 'graphql';
import {
  mutationWithClientMutationId,
  connectionArgs,
  connectionDefinitions,
  globalIdField
} from 'graphql-relay';
import model from './../model';
import type from './../type';
import query, {
  idToCursor,
  getIdFetcher,
  connectionFromModel
} from './../query';
import { addHooks } from '../utils';
import viewerInstance from '../model/viewer';
import createInputObject from '../type/custom/to-input-object';

const debug = require('debug')('graffiti-mongoose:schema');

const idField = {
  name: 'id',
  type: new GraphQLNonNull(GraphQLID)
};

const schemaCache = new NodeCache({
  stdTTL: process.env.GQL_SCHEMA_TIMEOUT || 60 * 60, // 1h
  useClones: false,
});

function getSingularQueryField(graffitiModel, type, hooks = {}) {
  const { name } = type;
  const { singular } = hooks;
  const singularName = new Inflectors(name).toSingular();

  return {
    [singularName]: {
      type,
      args: {
        id: idField
      },
      resolve: addHooks(query.getOneResolver(graffitiModel), singular)
    }
  };
}

function getPluralQueryField(graffitiModel, type, hooks = {}, typeContext) {
  const { name } = type;
  const { plural } = hooks;
  const pluralName = new Inflectors(name).toPlural();

  return {
    [pluralName]: {
      type: new GraphQLList(type),
      args: typeContext.getArguments(type, {
        id: {
          type: new GraphQLList(GraphQLID),
          description: `The ID of a ${name}`
        },
        ids: {
          type: new GraphQLList(GraphQLID),
          description: `The ID of a ${name}`
        }
      }),
      resolve: addHooks(query.getListResolver(graffitiModel), plural)
    }
  };
}

function getQueryField(graffitiModel, type, hooks, typeContext) {
  return {
    ...getSingularQueryField(graffitiModel, type, hooks, typeContext),
    ...getPluralQueryField(graffitiModel, type, hooks, typeContext)
  };
}

function getConnectionField(graffitiModel, type, hooks = {}, typeContext) {
  const { name } = type;
  const { plural } = hooks;
  const pluralName = new Inflectors(name).toPlural();
  const { connectionType } = connectionDefinitions({
    name,
    nodeType: type,
    connectionFields: {
      count: {
        name: 'count',
        type: GraphQLFloat
      }
    }
  });

  return {
    [pluralName]: {
      args: typeContext.getArguments(type, connectionArgs),
      type: connectionType,
      resolve: addHooks((rootValue, args, info) => connectionFromModel(graffitiModel, args, info), plural)
    }
  };
}

function getMutationField(graffitiModel, type, viewer, hooks = {}, allowMongoIDMutation, typeContext) {
  const { name } = type;
  const { mutation } = hooks;

  const fields = typeContext.getTypeFields(type);
  const inputFields = reduce(fields, (inputFields, field) => {
    if (field.type instanceof GraphQLObjectType) {
      if (field.type.name.endsWith('Connection')) {
        inputFields[field.name] = {
          name: field.name,
          type: new GraphQLList(GraphQLID)
        };
      } else if (field.type.mongooseEmbedded) {
        inputFields[field.name] = {
          name: field.name,
          type: createInputObject(field.type)
        };
      } else {
        inputFields[field.name] = {
          name: field.name,
          type: GraphQLID
        };
      }
    }

    if (field.type instanceof GraphQLList && field.type.ofType instanceof GraphQLObjectType) {
      inputFields[field.name] = {
        name: field.name,
        type: new GraphQLList(createInputObject(field.type.ofType))
      };
    } else if (!(field.type instanceof GraphQLObjectType)
        && field.name !== 'id' && field.name !== '__v'
        && (allowMongoIDMutation || field.name !== '_id')) {
      inputFields[field.name] = {
        name: field.name,
        type: field.type
      };
    }

    return inputFields;
  }, {});

  const updateInputFields = reduce(fields, (inputFields, field) => {
    if (field.type instanceof GraphQLObjectType && field.type.name.endsWith('Connection')) {
      inputFields[`${field.name}_add`] = {
        name: field.name,
        type: new GraphQLList(GraphQLID)
      };
    }

    return inputFields;
  }, {});

  const changedName = `changed${name}`;
  const edgeName = `${changedName}Edge`;
  const nodeName = `${changedName}Node`;

  const addName = `add${name}`;
  const updateName = `update${name}`;
  const deleteName = `delete${name}`;

  return {
    [addName]: mutationWithClientMutationId({
      name: addName,
      inputFields,
      outputFields: {
        viewer,
        [edgeName]: {
          type: connectionDefinitions({
            name: changedName,
            nodeType: new GraphQLObjectType({
              name: nodeName,
              fields
            })
          }).edgeType,
          resolve: (node) => ({
            node,
            cursor: idToCursor(node.id)
          })
        }
      },
      mutateAndGetPayload: addHooks(query.getAddOneMutateHandler(graffitiModel), mutation)
    }),
    [updateName]: mutationWithClientMutationId({
      name: updateName,
      inputFields: {
        ...inputFields,
        ...updateInputFields,
        id: idField
      },
      outputFields: {
        [changedName]: {
          type,
          resolve: (node) => node
        }
      },
      mutateAndGetPayload: addHooks(query.getUpdateOneMutateHandler(graffitiModel), mutation)
    }),
    [deleteName]: mutationWithClientMutationId({
      name: deleteName,
      inputFields: {
        id: idField
      },
      outputFields: {
        viewer,
        ok: {
          type: GraphQLBoolean
        },
        id: idField
      },
      mutateAndGetPayload: addHooks(query.getDeleteOneMutateHandler(graffitiModel), mutation)
    })
  };
}

/**
 * Returns query and mutation root fields
 * @param  {Array} graffitiModels
 * @param  {{Object, Boolean}} {hooks, mutation, allowMongoIDMutation}
 * @return {Object}
 */
function getFields(graffitiModels, {
    hooks = {}, mutation = true, allowMongoIDMutation = false,
    customQueries = {}, customMutations = {},
    typeContext,
  } = {}) {
  const types = typeContext.getTypes(graffitiModels);
  debug('load schema types...', types);
  const { viewer, singular } = hooks;

  const viewerFields = reduce(types, (fields, type, key) => {
    type.name = type.name || key;
    const graffitiModel = graffitiModels[type.name];
    return {
      ...fields,
      ...getConnectionField(graffitiModel, type, hooks, typeContext),
      ...getSingularQueryField(graffitiModel, type, hooks, typeContext)
    };
  }, {
    id: globalIdField('Viewer')
  });
  typeContext.setTypeFields(typeContext.GraphQLViewer, viewerFields);

  const viewerField = {
    name: 'Viewer',
    type: typeContext.GraphQLViewer,
    resolve: addHooks(() => viewerInstance, viewer)
  };

  const { queries, mutations } = reduce(types, ({ queries, mutations }, type, key) => {
    type.name = type.name || key;
    const graffitiModel = graffitiModels[type.name];
    return {
      queries: {
        ...queries,
        ...getQueryField(graffitiModel, type, hooks, typeContext)
      },
      mutations: {
        ...mutations,
        ...getMutationField(graffitiModel, type, viewerField, hooks, allowMongoIDMutation, typeContext)
      }
    };
  }, {
    queries: isFunction(customQueries)
      ? customQueries(mapValues(types, (type) => createInputObject(type)), types)
      : customQueries,
    mutations: isFunction(customMutations)
      ? customMutations(mapValues(types, (type) => createInputObject(type)), types)
      : customMutations
  });

  const RootQuery = new GraphQLObjectType({
    name: 'RootQuery',
    fields: {
      ...queries,
      viewer: viewerField,
      node: {
        name: 'node',
        description: 'Fetches an object given its ID',
        type: typeContext.nodeInterface,
        args: {
          id: {
            type: new GraphQLNonNull(GraphQLID),
            description: 'The ID of an object'
          }
        },
        resolve: addHooks(getIdFetcher(graffitiModels), singular)
      }
    }
  });

  const RootMutation = new GraphQLObjectType({
    name: 'RootMutation',
    fields: mutations
  });

  const fields = {
    query: RootQuery
  };

  if (mutation) {
    fields.mutation = RootMutation;
  }

  return fields;
}

/**
 * Returns a GraphQL schema including query and mutation fields
 * @param  {Array} mongooseModels
 * @param  {Object} options
 * @return {GraphQLSchema}
 */
function getSchema(mongooseModels, options) {
  if (!isArray(mongooseModels)) {
    mongooseModels = [mongooseModels];
  }
  let schema;
  const haskey = options.cacheKey ||
    stringHash(mongooseModels.map((model) => model.versionedName || model.modelName).join('#'));
  const cache = options.schemaCache || schemaCache;
  if (cache) {
    schema = cache.get(haskey);
    if (schema) {
      cache.ttl(haskey);
      debug('cache', haskey);
      return schema;
    }
  }
  // 每次查询都会建立一个context，从cache中填充model和type
  const modelCache = options.modelCache || model.modelCache;
  const modelContext = options.modelContext || model.createModelContext(modelCache);
  const typeCache = options.typeCache || type.typeCache;
  const typeContext = options.typeContext || type.createTypeContext(typeCache);
  const graffitiModels = modelContext.getModels(mongooseModels);
  const fields = getFields(graffitiModels, { ...options, typeContext });
  debug('load fields', fields);
  schema = new GraphQLSchema(fields);
  debug('create', schema);
  if (cache) {
    cache.set(haskey, schema);
  }
  return schema;
}

export {
  getQueryField,
  getMutationField,
  getFields,
  getSchema
};
