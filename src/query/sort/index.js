import {
  orderBy
} from 'lodash';
import {
  parseValue
} from '../../utils';

function getSortObject(info, fieldNodes, parentName) {
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
  const fieldArr = selections.reduce((list, ast) => {
    const {
      name,
      kind
    } = ast;
    const prefix = (parentName ? `${parentName}.` : '') + name.value;
    const args = ast.arguments;
    let sortArg;
    let orderArg;
    switch (kind) {
      case 'Field':
        sortArg = args.find((it) => it.name.value === 'sort');
        orderArg = args.find((it) => it.name.value === 'sortOrder');
        if (!sortArg) {
          return {
            ...list,
            ...getSortObject(info, ast),
          };
        }
        return [
          ...list,
          ...getSortObject(info, ast, prefix),
          {
            name: prefix,
            value: parseInt(parseValue(info, sortArg.value), 10) || 1,
            order: orderArg ? parseInt(orderArg.value.value, 10) : Infinity,
          }
        ];
      case 'InlineFragment':
        return [
          ...list,
          ...getSortObject(info, ast, prefix)
        ];
      case 'FragmentSpread':
        return [
          ...list,
          ...getSortObject(info, info.fragments[name.value], prefix)
        ];
      default:
        throw new Error('Unsuported query selection');
    }
  }, []);

  return orderBy(fieldArr, ['order', 'name', 'value'], ['asc']).reduce((sorts, it) => (it.name ? {
    ...sorts,
    [it.name]: it.value
  } : sorts), {});
}

export default getSortObject;
