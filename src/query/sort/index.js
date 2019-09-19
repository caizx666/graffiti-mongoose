import {
  orderBy
} from 'lodash';

function getSortObject(info, fieldNodes) {
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
          ...getSortObject(info, ast),
          {
            name: sortArg.name.value,
            value: parseInt(sortArg.value.value, 10) || 1,
            order: orderArg ? parseInt(orderArg.value.value, 10) : Infinity,
          }
        ];
      case 'InlineFragment':
        return [
          ...list,
          ...getSortObject(info, ast)
        ];
      case 'FragmentSpread':
        return [
          ...list,
          ...getSortObject(info, info.fragments[name.value])
        ];
      default:
        throw new Error('Unsuported query selection');
    }
  }, []);

  return orderBy(fieldArr, ['order', 'name', 'value'], ['asc']).reduce((sorts, it) => ({
    ...sorts,
    [it.name]: it.value
  }), {});
}

export default getSortObject;
