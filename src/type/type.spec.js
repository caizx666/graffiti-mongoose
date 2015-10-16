import {expect} from 'chai';
import {
  GraphQLString,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull
} from 'graphql/type';

import {
  GraphQLDate,
  GraphQLGeneric,
  getType,
  getTypes
} from './';

describe('type', () => {
  let user;
  before(() => {
    user = {
      name: 'User',
      fields: {
        name: {
          type: 'String'
        },
        age: {
          type: 'Number'
        },
        mother: {
          type: 'ObjectID',
          reference: 'User',
          description: 'The user\'s mother'
        },
        friends: {
          type: 'Array',
          subtype: 'ObjectID',
          reference: 'User'
        },
        weight: {
          type: 'Number'
        },
        createdAt: {
          type: 'Date'
        },
        removed: {
          type: 'Boolean'
        },
        nums: {
          type: 'Array',
          subtype: 'Number'
        },
        unknownType: {
          type: 'Unknown'
        },
        hidden: {
          type: 'String',
          hidden: true
        },
        sub: {
          type: 'Object',
          fields: {
            foo: {
              type: 'String'
            },
            nums: {
              type: 'Array',
              subtype: 'Number'
            },
            subsub: {
              type: 'Object',
              fields: {
                bar: {
                  type: 'Number'
                }
              }
            }
          }
        }
      }
    };
  });

  describe('getType', () => {
    it('should implement the Node interface', () => {
      const result = getType([], user);
      expect(result._interfaces).to.containSubset([{
        name: 'Node'
      }]);
      expect(result._typeConfig.fields()).to.containSubset({
        id: {
          type: new GraphQLNonNull(GraphQLID)
        }
      });
    });

    it('should specify the fields', () => {
      const result = getType([], user);
      let fields = result._typeConfig.fields();
      expect(fields).to.containSubset({
        name: {
          name: 'name',
          type: GraphQLString
        },
        age: {
          name: 'age',
          type: GraphQLFloat
        },
        mother: {
          name: 'mother',
          type: GraphQLID,
          description: 'The user\'s mother'
        },
        friends: {
          name: 'friends',
          type: new GraphQLList(GraphQLID)
        },
        weight: {
          name: 'weight',
          type: GraphQLFloat
        },
        createdAt: {
          name: 'createdAt',
          type: GraphQLDate
        },
        removed: {
          name: 'removed',
          type: GraphQLBoolean
        },
        nums: {
          name: 'nums',
          type: new GraphQLList(GraphQLFloat)
        },
        unknownType: {
          name: 'unknownType',
          type: GraphQLGeneric
        },
        sub: {
          name: 'sub'
        }
      });

      // sub
      fields = fields.sub.type._typeConfig.fields();
      expect(fields).to.containSubset({
        foo: {
          name: 'foo',
          type: GraphQLString
        },
        nums: {
          name: 'nums',
          type: new GraphQLList(GraphQLFloat)
        },
        subsub: {
          name: 'subsub'
        }
      });

      // subsub
      fields = fields.subsub.type._typeConfig.fields();
      expect(fields).to.containSubset({
        bar: {
          name: 'bar',
          type: GraphQLFloat
        }
      });
    });

    it('should not include hidden fields', () => {
      const result = getType([], user);
      const fields = result._typeConfig.fields();
      expect(fields.hidden).to.be.eql(undefined);
    });
  });

  describe('getTypes', () => {
    it('should resolve the references', () => {
      const result = getTypes([user]);
      const userType = result[user.name];
      const fields = userType._typeConfig.fields();

      expect(fields.mother.type).to.be.equal(userType);

      // connection type
      const nodeField = fields.friends.type._typeConfig.fields().edges.type.ofType._typeConfig.fields().node;
      expect(nodeField.type).to.be.equal(userType);
    });
  });
});