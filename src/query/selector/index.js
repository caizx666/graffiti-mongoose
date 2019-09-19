import {
  parseValue
} from '../../utils';

// $eq    Matches values that are equal to a specified value.
// $gt    Matches values that are greater than a specified value.
// $gte    Matches values that are greater than or equal to a specified value.
// $lt    Matches values that are less than a specified value.
// $lte    Matches values that are less than or equal to a specified value.
// $ne    Matches all values that are not equal to a specified value.
// $in    Matches any of the values specified in an array.
// $nin    Matches none of the values specified in an array.
const names = ['eq', 'gt', 'gte', 'lt', 'lte', 'ne', 'in', 'nin'];

function getFilterObject(info, fieldNodes, parentName) {
  if (!info) {
    return {};
  }

  fieldNodes = fieldNodes || info.fieldNodes;

  // for recursion
  // Fragments doesn't have many sets
  let nodes = fieldNodes;
  if (!Array.isArray(nodes)) {
    nodes = nodes ? [nodes] : [];
  }

  // get all selectionSets
  const selections = nodes.reduce((selections, source) => {
    if (source.selectionSet) {
      return selections.concat(source.selectionSet.selections);
    }

    return selections;
  }, []);

  // return fields
  return selections.reduce((list, ast) => {
    const {
      name,
      kind
    } = ast;
    const prefix = (parentName ? `${parentName}.` : '') + name.value;
    const args = ast.arguments;
    let filters;
    let op;
    let config;
    switch (kind) {
      case 'Field':
        filters = args.filter((it) => names.indexOf(it.name.value) > -1).map((it) => ({
          [`$${it.name.value}`]: parseValue(info, it.value)
        }));
        op = (args.find((it) => it.name.value === 'op') || {
          value: {
            value: 'and'
          }
        }).value.value;
        config = filters.length > 0 ? {
          [prefix]: filters.length > 1 ? {
            [`$${op}`]: filters
          } : filters[0]
        } : {};
        return {
          ...list,
          ...getFilterObject(info, ast, prefix),
          ...config
        };
      case 'InlineFragment':
        return {
          ...list,
          ...getFilterObject(info, ast, prefix)
        };
      case 'FragmentSpread':
        return {
          ...list,
          ...getFilterObject(info, info.fragments[name.value], prefix)
        };
      default:
        throw new Error('Unsuported query selection');
    }
  }, {});
}

export default getFilterObject;
