import { graphql } from 'graphql';
import { createTypeContext } from './type';
import { getSchema } from './schema';
import { createModelContext } from './model';

function _getTypes(mongooseModels, context = {
  modelContext: createModelContext(),
  typeContext: createTypeContext(),
}) {
  const graffitiModels = context.modelContext.getModels(mongooseModels);
  return context.typeContext.getTypes(graffitiModels);
}

export default {
  graphql,
  getSchema,
  getTypes: _getTypes
};

export {
  graphql,
  getSchema,
  _getTypes as getTypes
};
