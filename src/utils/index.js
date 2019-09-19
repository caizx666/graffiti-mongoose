import {
  Kind
} from 'graphql';
import Middleware from './Middleware';

function parseValue(info, {
  kind,
  name,
  value,
  values
}) {
  switch (kind) {
    case Kind.VARIABLE:
      return info.variableValues[name.value];
    case Kind.INT:
      return parseInt(value, 10);
    case Kind.FLOAT:
      return parseFloat(value, 10);
    case Kind.STRING:
      return value;
    case Kind.BOOLEAN:
      return Boolean(value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return values.map(parseValue);
    case Kind.ENUM:
    case Kind.OBJECT:
    case Kind.OBJECT_FIELD:
    default:
      return value;
  }
}

function addHooks(resolver, { pre, post } = {}) {
  return async function resolve(...args) {
    const preMiddleware = new Middleware(pre);
    await preMiddleware.compose(...args);
    const postMiddleware = new Middleware(post);
    const result = await resolver(...args);
    return await postMiddleware.compose(result, ...args) || result;
  };
}

export default {
  Middleware,
  addHooks,
  parseValue
};

export {
  Middleware,
  addHooks,
  parseValue
};
