"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "extractKeysAndInclude", {
  enumerable: true,
  get: function () {
    return _parseGraphQLUtils.extractKeysAndInclude;
  }
});
exports.load = void 0;

var _graphql = require("graphql");

var _graphqlListFields = _interopRequireDefault(require("graphql-list-fields"));

var defaultGraphQLTypes = _interopRequireWildcard(require("./defaultGraphQLTypes"));

var objectsQueries = _interopRequireWildcard(require("../helpers/objectsQueries"));

var _ParseGraphQLController = require("../../Controllers/ParseGraphQLController");

var _className = require("../transformers/className");

var _inputType = require("../transformers/inputType");

var _outputType = require("../transformers/outputType");

var _constraintType = require("../transformers/constraintType");

var _parseGraphQLUtils = require("../parseGraphQLUtils");

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { keys.push.apply(keys, Object.getOwnPropertySymbols(object)); } if (enumerableOnly) keys = keys.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const getParseClassTypeConfig = function (parseClassConfig) {
  return parseClassConfig && parseClassConfig.type || {};
};

const getInputFieldsAndConstraints = function (parseClass, parseClassConfig) {
  const classFields = Object.keys(parseClass.fields).filter(field => field !== 'objectId').concat('id');
  const {
    inputFields: allowedInputFields,
    outputFields: allowedOutputFields,
    constraintFields: allowedConstraintFields,
    sortFields: allowedSortFields
  } = getParseClassTypeConfig(parseClassConfig);
  let classOutputFields;
  let classCreateFields;
  let classUpdateFields;
  let classConstraintFields;
  let classSortFields; // All allowed customs fields

  const classCustomFields = classFields.filter(field => {
    return !Object.keys(defaultGraphQLTypes.PARSE_OBJECT_FIELDS).includes(field);
  });

  if (allowedInputFields && allowedInputFields.create) {
    classCreateFields = classCustomFields.filter(field => {
      return allowedInputFields.create.includes(field);
    });
  } else {
    classCreateFields = classCustomFields;
  }

  if (allowedInputFields && allowedInputFields.update) {
    classUpdateFields = classCustomFields.filter(field => {
      return allowedInputFields.update.includes(field);
    });
  } else {
    classUpdateFields = classCustomFields;
  }

  if (allowedOutputFields) {
    classOutputFields = classCustomFields.filter(field => {
      return allowedOutputFields.includes(field);
    });
  } else {
    classOutputFields = classCustomFields;
  } // Filters the "password" field from class _User


  if (parseClass.className === '_User') {
    classOutputFields = classOutputFields.filter(outputField => outputField !== 'password');
  }

  if (allowedConstraintFields) {
    classConstraintFields = classCustomFields.filter(field => {
      return allowedConstraintFields.includes(field);
    });
  } else {
    classConstraintFields = classFields;
  }

  if (allowedSortFields) {
    classSortFields = allowedSortFields;

    if (!classSortFields.length) {
      // must have at least 1 order field
      // otherwise the FindArgs Input Type will throw.
      classSortFields.push({
        field: 'id',
        asc: true,
        desc: true
      });
    }
  } else {
    classSortFields = classFields.map(field => {
      return {
        field,
        asc: true,
        desc: true
      };
    });
  }

  return {
    classCreateFields,
    classUpdateFields,
    classConstraintFields,
    classOutputFields,
    classSortFields
  };
};

const load = (parseGraphQLSchema, parseClass, parseClassConfig) => {
  const className = parseClass.className;
  const graphQLClassName = (0, _className.transformClassNameToGraphQL)(className);
  const {
    classCreateFields,
    classUpdateFields,
    classOutputFields,
    classConstraintFields,
    classSortFields
  } = getInputFieldsAndConstraints(parseClass, parseClassConfig);
  const {
    create: isCreateEnabled = true,
    update: isUpdateEnabled = true
  } = (0, _parseGraphQLUtils.getParseClassMutationConfig)(parseClassConfig);
  const classGraphQLCreateTypeName = `Create${graphQLClassName}FieldsInput`;
  let classGraphQLCreateType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLCreateTypeName,
    description: `The ${classGraphQLCreateTypeName} input type is used in operations that involve creation of objects in the ${graphQLClassName} class.`,
    fields: () => classCreateFields.reduce((fields, field) => {
      const type = (0, _inputType.transformInputTypeToGraphQL)(parseClass.fields[field].type, parseClass.fields[field].targetClass, parseGraphQLSchema.parseClassTypes);

      if (type) {
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            type
          }
        });
      } else {
        return fields;
      }
    }, {
      ACL: defaultGraphQLTypes.ACL_ATT
    })
  });
  classGraphQLCreateType = parseGraphQLSchema.addGraphQLType(classGraphQLCreateType);
  const classGraphQLUpdateTypeName = `Update${graphQLClassName}FieldsInput`;
  let classGraphQLUpdateType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLUpdateTypeName,
    description: `The ${classGraphQLUpdateTypeName} input type is used in operations that involve creation of objects in the ${graphQLClassName} class.`,
    fields: () => classUpdateFields.reduce((fields, field) => {
      const type = (0, _inputType.transformInputTypeToGraphQL)(parseClass.fields[field].type, parseClass.fields[field].targetClass, parseGraphQLSchema.parseClassTypes);

      if (type) {
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            type
          }
        });
      } else {
        return fields;
      }
    }, {
      ACL: defaultGraphQLTypes.ACL_ATT
    })
  });
  classGraphQLUpdateType = parseGraphQLSchema.addGraphQLType(classGraphQLUpdateType);
  const classGraphQLPointerTypeName = `${graphQLClassName}PointerInput`;
  let classGraphQLPointerType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLPointerTypeName,
    description: `Allow to link OR add and link an object of the ${graphQLClassName} class.`,
    fields: () => {
      const fields = {
        link: {
          description: `Link an existing object from ${graphQLClassName} class.`,
          type: _graphql.GraphQLID
        }
      };

      if (isCreateEnabled) {
        fields['createAndLink'] = {
          description: `Create and link an object from ${graphQLClassName} class.`,
          type: classGraphQLCreateType
        };
      }

      return fields;
    }
  });
  classGraphQLPointerType = parseGraphQLSchema.addGraphQLType(classGraphQLPointerType) || defaultGraphQLTypes.OBJECT;
  const classGraphQLRelationTypeName = `${graphQLClassName}RelationInput`;
  let classGraphQLRelationType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLRelationTypeName,
    description: `Allow to add, remove, createAndAdd objects of the ${graphQLClassName} class into a relation field.`,
    fields: () => {
      const fields = {
        add: {
          description: `Add an existing object from the ${graphQLClassName} class into the relation.`,
          type: new _graphql.GraphQLList(defaultGraphQLTypes.OBJECT_ID)
        },
        remove: {
          description: `Remove an existing object from the ${graphQLClassName} class out of the relation.`,
          type: new _graphql.GraphQLList(defaultGraphQLTypes.OBJECT_ID)
        }
      };

      if (isCreateEnabled) {
        fields['createAndAdd'] = {
          description: `Create and add an object of the ${graphQLClassName} class into the relation.`,
          type: new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLCreateType))
        };
      }

      return fields;
    }
  });
  classGraphQLRelationType = parseGraphQLSchema.addGraphQLType(classGraphQLRelationType) || defaultGraphQLTypes.OBJECT;
  const classGraphQLConstraintTypeName = `${graphQLClassName}PointerWhereInput`;
  let classGraphQLConstraintType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLConstraintTypeName,
    description: `The ${classGraphQLConstraintTypeName} input type is used in operations that involve filtering objects by a pointer field to ${graphQLClassName} class.`,
    fields: {
      equalTo: defaultGraphQLTypes.equalTo(_graphql.GraphQLID),
      notEqualTo: defaultGraphQLTypes.notEqualTo(_graphql.GraphQLID),
      in: defaultGraphQLTypes.inOp(defaultGraphQLTypes.OBJECT_ID),
      notIn: defaultGraphQLTypes.notIn(defaultGraphQLTypes.OBJECT_ID),
      exists: defaultGraphQLTypes.exists,
      inQueryKey: defaultGraphQLTypes.inQueryKey,
      notInQueryKey: defaultGraphQLTypes.notInQueryKey,
      inQuery: {
        description: 'This is the inQuery operator to specify a constraint to select the objects where a field equals to any of the ids in the result of a different query.',
        type: defaultGraphQLTypes.SUBQUERY_INPUT
      },
      notInQuery: {
        description: 'This is the notInQuery operator to specify a constraint to select the objects where a field do not equal to any of the ids in the result of a different query.',
        type: defaultGraphQLTypes.SUBQUERY_INPUT
      }
    }
  });
  classGraphQLConstraintType = parseGraphQLSchema.addGraphQLType(classGraphQLConstraintType);
  const classGraphQLConstraintsTypeName = `${graphQLClassName}WhereInput`;
  let classGraphQLConstraintsType = new _graphql.GraphQLInputObjectType({
    name: classGraphQLConstraintsTypeName,
    description: `The ${classGraphQLConstraintsTypeName} input type is used in operations that involve filtering objects of ${graphQLClassName} class.`,
    fields: () => _objectSpread({}, classConstraintFields.reduce((fields, field) => {
      if (['OR', 'AND', 'NOR'].includes(field)) {
        parseGraphQLSchema.log.warn(`Field ${field} could not be added to the auto schema ${classGraphQLConstraintsTypeName} because it collided with an existing one.`);
        return fields;
      }

      const parseField = field === 'id' ? 'objectId' : field;
      const type = (0, _constraintType.transformConstraintTypeToGraphQL)(parseClass.fields[parseField].type, parseClass.fields[parseField].targetClass, parseGraphQLSchema.parseClassTypes);

      if (type) {
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            type
          }
        });
      } else {
        return fields;
      }
    }, {}), {
      OR: {
        description: 'This is the OR operator to compound constraints.',
        type: new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLConstraintsType))
      },
      AND: {
        description: 'This is the AND operator to compound constraints.',
        type: new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLConstraintsType))
      },
      NOR: {
        description: 'This is the NOR operator to compound constraints.',
        type: new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLConstraintsType))
      }
    })
  });
  classGraphQLConstraintsType = parseGraphQLSchema.addGraphQLType(classGraphQLConstraintsType) || defaultGraphQLTypes.OBJECT;
  const classGraphQLOrderTypeName = `${graphQLClassName}Order`;
  let classGraphQLOrderType = new _graphql.GraphQLEnumType({
    name: classGraphQLOrderTypeName,
    description: `The ${classGraphQLOrderTypeName} input type is used when sorting objects of the ${graphQLClassName} class.`,
    values: classSortFields.reduce((sortFields, fieldConfig) => {
      const {
        field,
        asc,
        desc
      } = fieldConfig;

      const updatedSortFields = _objectSpread({}, sortFields);

      if (asc) {
        updatedSortFields[`${field}_ASC`] = {
          value: field
        };
      }

      if (desc) {
        updatedSortFields[`${field}_DESC`] = {
          value: `-${field}`
        };
      }

      return updatedSortFields;
    }, {})
  });
  classGraphQLOrderType = parseGraphQLSchema.addGraphQLType(classGraphQLOrderType);
  const classGraphQLFindArgs = {
    where: {
      description: 'These are the conditions that the objects need to match in order to be found.',
      type: classGraphQLConstraintsType
    },
    order: {
      description: 'The fields to be used when sorting the data fetched.',
      type: classGraphQLOrderType ? new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLOrderType)) : _graphql.GraphQLString
    },
    skip: defaultGraphQLTypes.SKIP_ATT,
    limit: defaultGraphQLTypes.LIMIT_ATT,
    options: defaultGraphQLTypes.READ_OPTIONS_ATT
  };
  const classGraphQLOutputTypeName = `${graphQLClassName}`;

  const outputFields = () => {
    return classOutputFields.reduce((fields, field) => {
      const type = (0, _outputType.transformOutputTypeToGraphQL)(parseClass.fields[field].type, parseClass.fields[field].targetClass, parseGraphQLSchema.parseClassTypes);

      if (parseClass.fields[field].type === 'Relation') {
        const targetParseClassTypes = parseGraphQLSchema.parseClassTypes[parseClass.fields[field].targetClass];
        const args = targetParseClassTypes ? targetParseClassTypes.classGraphQLFindArgs : undefined;
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            args,
            type,

            async resolve(source, args, context, queryInfo) {
              try {
                const {
                  where,
                  order,
                  skip,
                  limit,
                  options
                } = args;
                const {
                  readPreference,
                  includeReadPreference,
                  subqueryReadPreference
                } = options || {};
                const {
                  config,
                  auth,
                  info
                } = context;
                const selectedFields = (0, _graphqlListFields.default)(queryInfo);
                const {
                  keys,
                  include
                } = (0, _parseGraphQLUtils.extractKeysAndInclude)(selectedFields.filter(field => field.includes('.')).map(field => field.slice(field.indexOf('.') + 1)));
                return await objectsQueries.findObjects(source[field].className, _objectSpread({
                  $relatedTo: {
                    object: {
                      __type: 'Pointer',
                      className: className,
                      objectId: source.objectId
                    },
                    key: field
                  }
                }, where || {}), order, skip, limit, keys, include, false, readPreference, includeReadPreference, subqueryReadPreference, config, auth, info, selectedFields.map(field => field.split('.', 1)[0]), parseClass.fields);
              } catch (e) {
                parseGraphQLSchema.handleError(e);
              }
            }

          }
        });
      } else if (parseClass.fields[field].type === 'Polygon') {
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            type,

            async resolve(source) {
              if (source[field] && source[field].coordinates) {
                return source[field].coordinates.map(coordinate => ({
                  latitude: coordinate[0],
                  longitude: coordinate[1]
                }));
              } else {
                return null;
              }
            }

          }
        });
      } else if (parseClass.fields[field].type === 'Array') {
        return _objectSpread({}, fields, {
          [field]: {
            description: `Use Inline Fragment on Array to get results: https://graphql.org/learn/queries/#inline-fragments`,
            type,

            async resolve(source) {
              if (!source[field]) return null;
              return source[field].map(async elem => {
                if (elem.className && elem.objectId && elem.__type === 'Object') {
                  return elem;
                } else {
                  return {
                    value: elem
                  };
                }
              });
            }

          }
        });
      } else if (type) {
        return _objectSpread({}, fields, {
          [field]: {
            description: `This is the object ${field}.`,
            type
          }
        });
      } else {
        return fields;
      }
    }, defaultGraphQLTypes.PARSE_OBJECT_FIELDS);
  };

  let classGraphQLOutputType = new _graphql.GraphQLObjectType({
    name: classGraphQLOutputTypeName,
    description: `The ${classGraphQLOutputTypeName} object type is used in operations that involve outputting objects of ${graphQLClassName} class.`,
    interfaces: [defaultGraphQLTypes.PARSE_OBJECT],
    fields: outputFields
  });
  classGraphQLOutputType = parseGraphQLSchema.addGraphQLType(classGraphQLOutputType);
  const classGraphQLFindResultTypeName = `${graphQLClassName}FindResult`;
  let classGraphQLFindResultType = new _graphql.GraphQLObjectType({
    name: classGraphQLFindResultTypeName,
    description: `The ${classGraphQLFindResultTypeName} object type is used in the ${graphQLClassName} find query to return the data of the matched objects.`,
    fields: {
      results: {
        description: 'This is the objects returned by the query',
        type: new _graphql.GraphQLNonNull(new _graphql.GraphQLList(new _graphql.GraphQLNonNull(classGraphQLOutputType || defaultGraphQLTypes.OBJECT)))
      },
      count: defaultGraphQLTypes.COUNT_ATT
    }
  });
  classGraphQLFindResultType = parseGraphQLSchema.addGraphQLType(classGraphQLFindResultType);
  parseGraphQLSchema.parseClassTypes[className] = {
    classGraphQLPointerType,
    classGraphQLRelationType,
    classGraphQLCreateType,
    classGraphQLUpdateType,
    classGraphQLConstraintType,
    classGraphQLConstraintsType,
    classGraphQLFindArgs,
    classGraphQLOutputType,
    classGraphQLFindResultType,
    config: {
      parseClassConfig,
      isCreateEnabled,
      isUpdateEnabled
    }
  };

  if (className === '_User') {
    const viewerType = new _graphql.GraphQLObjectType({
      name: 'Viewer',
      description: `The Viewer object type is used in operations that involve outputting the current user data.`,
      interfaces: [defaultGraphQLTypes.PARSE_OBJECT],
      fields: () => _objectSpread({}, outputFields(), {
        sessionToken: defaultGraphQLTypes.SESSION_TOKEN_ATT
      })
    });
    parseGraphQLSchema.viewerType = viewerType;
    parseGraphQLSchema.addGraphQLType(viewerType, true, true);
    const userSignUpInputTypeName = 'SignUpFieldsInput';
    const userSignUpInputType = new _graphql.GraphQLInputObjectType({
      name: userSignUpInputTypeName,
      description: `The ${userSignUpInputTypeName} input type is used in operations that involve inputting objects of ${graphQLClassName} class when signing up.`,
      fields: () => classCreateFields.reduce((fields, field) => {
        const type = (0, _inputType.transformInputTypeToGraphQL)(parseClass.fields[field].type, parseClass.fields[field].targetClass, parseGraphQLSchema.parseClassTypes);

        if (type) {
          return _objectSpread({}, fields, {
            [field]: {
              description: `This is the object ${field}.`,
              type: field === 'username' || field === 'password' ? new _graphql.GraphQLNonNull(type) : type
            }
          });
        } else {
          return fields;
        }
      }, {})
    });
    parseGraphQLSchema.addGraphQLType(userSignUpInputType, true, true);
    const userLogInInputTypeName = 'LogInFieldsInput';
    const userLogInInputType = new _graphql.GraphQLInputObjectType({
      name: userLogInInputTypeName,
      description: `The ${userLogInInputTypeName} input type is used to login.`,
      fields: {
        username: {
          description: 'This is the username used to log the user in.',
          type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
        },
        password: {
          description: 'This is the password used to log the user in.',
          type: new _graphql.GraphQLNonNull(_graphql.GraphQLString)
        }
      }
    });
    parseGraphQLSchema.addGraphQLType(userLogInInputType, true, true);
    parseGraphQLSchema.parseClassTypes[className].signUpInputType = userSignUpInputType;
    parseGraphQLSchema.parseClassTypes[className].logInInputType = userLogInInputType;
  }
};

exports.load = load;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9HcmFwaFFML2xvYWRlcnMvcGFyc2VDbGFzc1R5cGVzLmpzIl0sIm5hbWVzIjpbImdldFBhcnNlQ2xhc3NUeXBlQ29uZmlnIiwicGFyc2VDbGFzc0NvbmZpZyIsInR5cGUiLCJnZXRJbnB1dEZpZWxkc0FuZENvbnN0cmFpbnRzIiwicGFyc2VDbGFzcyIsImNsYXNzRmllbGRzIiwiT2JqZWN0Iiwia2V5cyIsImZpZWxkcyIsImZpbHRlciIsImZpZWxkIiwiY29uY2F0IiwiaW5wdXRGaWVsZHMiLCJhbGxvd2VkSW5wdXRGaWVsZHMiLCJvdXRwdXRGaWVsZHMiLCJhbGxvd2VkT3V0cHV0RmllbGRzIiwiY29uc3RyYWludEZpZWxkcyIsImFsbG93ZWRDb25zdHJhaW50RmllbGRzIiwic29ydEZpZWxkcyIsImFsbG93ZWRTb3J0RmllbGRzIiwiY2xhc3NPdXRwdXRGaWVsZHMiLCJjbGFzc0NyZWF0ZUZpZWxkcyIsImNsYXNzVXBkYXRlRmllbGRzIiwiY2xhc3NDb25zdHJhaW50RmllbGRzIiwiY2xhc3NTb3J0RmllbGRzIiwiY2xhc3NDdXN0b21GaWVsZHMiLCJkZWZhdWx0R3JhcGhRTFR5cGVzIiwiUEFSU0VfT0JKRUNUX0ZJRUxEUyIsImluY2x1ZGVzIiwiY3JlYXRlIiwidXBkYXRlIiwiY2xhc3NOYW1lIiwib3V0cHV0RmllbGQiLCJsZW5ndGgiLCJwdXNoIiwiYXNjIiwiZGVzYyIsIm1hcCIsImxvYWQiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJncmFwaFFMQ2xhc3NOYW1lIiwiaXNDcmVhdGVFbmFibGVkIiwiaXNVcGRhdGVFbmFibGVkIiwiY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZU5hbWUiLCJjbGFzc0dyYXBoUUxDcmVhdGVUeXBlIiwiR3JhcGhRTElucHV0T2JqZWN0VHlwZSIsIm5hbWUiLCJkZXNjcmlwdGlvbiIsInJlZHVjZSIsInRhcmdldENsYXNzIiwicGFyc2VDbGFzc1R5cGVzIiwiQUNMIiwiQUNMX0FUVCIsImFkZEdyYXBoUUxUeXBlIiwiY2xhc3NHcmFwaFFMVXBkYXRlVHlwZU5hbWUiLCJjbGFzc0dyYXBoUUxVcGRhdGVUeXBlIiwiY2xhc3NHcmFwaFFMUG9pbnRlclR5cGVOYW1lIiwiY2xhc3NHcmFwaFFMUG9pbnRlclR5cGUiLCJsaW5rIiwiR3JhcGhRTElEIiwiT0JKRUNUIiwiY2xhc3NHcmFwaFFMUmVsYXRpb25UeXBlTmFtZSIsImNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZSIsImFkZCIsIkdyYXBoUUxMaXN0IiwiT0JKRUNUX0lEIiwicmVtb3ZlIiwiR3JhcGhRTE5vbk51bGwiLCJjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZU5hbWUiLCJjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZSIsImVxdWFsVG8iLCJub3RFcXVhbFRvIiwiaW4iLCJpbk9wIiwibm90SW4iLCJleGlzdHMiLCJpblF1ZXJ5S2V5Iiwibm90SW5RdWVyeUtleSIsImluUXVlcnkiLCJTVUJRVUVSWV9JTlBVVCIsIm5vdEluUXVlcnkiLCJjbGFzc0dyYXBoUUxDb25zdHJhaW50c1R5cGVOYW1lIiwiY2xhc3NHcmFwaFFMQ29uc3RyYWludHNUeXBlIiwibG9nIiwid2FybiIsInBhcnNlRmllbGQiLCJPUiIsIkFORCIsIk5PUiIsImNsYXNzR3JhcGhRTE9yZGVyVHlwZU5hbWUiLCJjbGFzc0dyYXBoUUxPcmRlclR5cGUiLCJHcmFwaFFMRW51bVR5cGUiLCJ2YWx1ZXMiLCJmaWVsZENvbmZpZyIsInVwZGF0ZWRTb3J0RmllbGRzIiwidmFsdWUiLCJjbGFzc0dyYXBoUUxGaW5kQXJncyIsIndoZXJlIiwib3JkZXIiLCJHcmFwaFFMU3RyaW5nIiwic2tpcCIsIlNLSVBfQVRUIiwibGltaXQiLCJMSU1JVF9BVFQiLCJvcHRpb25zIiwiUkVBRF9PUFRJT05TX0FUVCIsImNsYXNzR3JhcGhRTE91dHB1dFR5cGVOYW1lIiwidGFyZ2V0UGFyc2VDbGFzc1R5cGVzIiwiYXJncyIsInVuZGVmaW5lZCIsInJlc29sdmUiLCJzb3VyY2UiLCJjb250ZXh0IiwicXVlcnlJbmZvIiwicmVhZFByZWZlcmVuY2UiLCJpbmNsdWRlUmVhZFByZWZlcmVuY2UiLCJzdWJxdWVyeVJlYWRQcmVmZXJlbmNlIiwiY29uZmlnIiwiYXV0aCIsImluZm8iLCJzZWxlY3RlZEZpZWxkcyIsImluY2x1ZGUiLCJzbGljZSIsImluZGV4T2YiLCJvYmplY3RzUXVlcmllcyIsImZpbmRPYmplY3RzIiwiJHJlbGF0ZWRUbyIsIm9iamVjdCIsIl9fdHlwZSIsIm9iamVjdElkIiwia2V5Iiwic3BsaXQiLCJlIiwiaGFuZGxlRXJyb3IiLCJjb29yZGluYXRlcyIsImNvb3JkaW5hdGUiLCJsYXRpdHVkZSIsImxvbmdpdHVkZSIsImVsZW0iLCJjbGFzc0dyYXBoUUxPdXRwdXRUeXBlIiwiR3JhcGhRTE9iamVjdFR5cGUiLCJpbnRlcmZhY2VzIiwiUEFSU0VfT0JKRUNUIiwiY2xhc3NHcmFwaFFMRmluZFJlc3VsdFR5cGVOYW1lIiwiY2xhc3NHcmFwaFFMRmluZFJlc3VsdFR5cGUiLCJyZXN1bHRzIiwiY291bnQiLCJDT1VOVF9BVFQiLCJ2aWV3ZXJUeXBlIiwic2Vzc2lvblRva2VuIiwiU0VTU0lPTl9UT0tFTl9BVFQiLCJ1c2VyU2lnblVwSW5wdXRUeXBlTmFtZSIsInVzZXJTaWduVXBJbnB1dFR5cGUiLCJ1c2VyTG9nSW5JbnB1dFR5cGVOYW1lIiwidXNlckxvZ0luSW5wdXRUeXBlIiwidXNlcm5hbWUiLCJwYXNzd29yZCIsInNpZ25VcElucHV0VHlwZSIsImxvZ0luSW5wdXRUeXBlIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7O0FBQUE7O0FBU0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7Ozs7Ozs7OztBQUtBLE1BQU1BLHVCQUF1QixHQUFHLFVBQzlCQyxnQkFEOEIsRUFFOUI7QUFDQSxTQUFRQSxnQkFBZ0IsSUFBSUEsZ0JBQWdCLENBQUNDLElBQXRDLElBQStDLEVBQXREO0FBQ0QsQ0FKRDs7QUFNQSxNQUFNQyw0QkFBNEIsR0FBRyxVQUNu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TSxNQUFQO0FBQ0Q7QUFDRixPQXBCRCxFQW9CRyxFQXBCSDtBQUptRCxLQUEzQixDQUE1QjtBQTBCQStCLElBQUFBLGtCQUFrQixDQUFDYyxjQUFuQixDQUFrQ21HLG1CQUFsQyxFQUF1RCxJQUF2RCxFQUE2RCxJQUE3RDtBQUVBLFVBQU1DLHNCQUFzQixHQUFHLGtCQUEvQjtBQUNBLFVBQU1DLGtCQUFrQixHQUFHLElBQUk3RywrQkFBSixDQUEyQjtBQUNwREMsTUFBQUEsSUFBSSxFQUFFMkcsc0JBRDhDO0FBRXBEMUcsTUFBQUEsV0FBVyxFQUFHLE9BQU0wRyxzQkFBdUIsK0JBRlM7QUFHcERqSixNQUFBQSxNQUFNLEVBQUU7QUFDTm1KLFFBQUFBLFFBQVEsRUFBRTtBQUNSNUcsVUFBQUEsV0FBVyxFQUFFLCtDQURMO0FBRVI3QyxVQUFBQSxJQUFJLEVBQUUsSUFBSWlFLHVCQUFKLENBQW1CZ0Msc0JBQW5CO0FBRkUsU0FESjtBQUtOeUQsUUFBQUEsUUFBUSxFQUFFO0FBQ1I3RyxVQUFBQSxXQUFXLEVBQUUsK0NBREw7QUFFUjdDLFVBQUFBLElBQUksRUFBRSxJQUFJaUUsdUJBQUosQ0FBbUJnQyxzQkFBbkI7QUFGRTtBQUxKO0FBSDRDLEtBQTNCLENBQTNCO0FBY0E1RCxJQUFBQSxrQkFBa0IsQ0FBQ2MsY0FBbkIsQ0FBa0NxRyxrQkFBbEMsRUFBc0QsSUFBdEQsRUFBNEQsSUFBNUQ7QUFFQW5ILElBQUFBLGtCQUFrQixDQUFDVyxlQUFuQixDQUNFbkIsU0FERixFQUVFOEgsZUFGRixHQUVvQkwsbUJBRnBCO0FBR0FqSCxJQUFBQSxrQkFBa0IsQ0FBQ1csZUFBbkIsQ0FDRW5CLFNBREYsRUFFRStILGNBRkYsR0FFbUJKLGtCQUZuQjtBQUdEO0FBQ0YsQ0E3ZUQiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQge1xuICBHcmFwaFFMSUQsXG4gIEdyYXBoUUxPYmplY3RUeXBlLFxuICBHcmFwaFFMU3RyaW5nLFxuICBHcmFwaFFMTGlzdCxcbiAgR3JhcGhRTElucHV0T2JqZWN0VHlwZSxcbiAgR3JhcGhRTE5vbk51bGwsXG4gIEdyYXBoUUxFbnVtVHlwZSxcbn0gZnJvbSAnZ3JhcGhxbCc7XG5pbXBvcnQgZ2V0RmllbGROYW1lcyBmcm9tICdncmFwaHFsLWxpc3QtZmllbGRzJztcbmltcG9ydCAqIGFzIGRlZmF1bHRHcmFwaFFMVHlwZXMgZnJvbSAnLi9kZWZhdWx0R3JhcGhRTFR5cGVzJztcbmltcG9ydCAqIGFzIG9iamVjdHNRdWVyaWVzIGZyb20gJy4uL2hlbHBlcnMvb2JqZWN0c1F1ZXJpZXMnO1xuaW1wb3J0IHsgUGFyc2VHcmFwaFFMQ2xhc3NDb25maWcgfSBmcm9tICcuLi8uLi9Db250cm9sbGVycy9QYXJzZUdyYXBoUUxDb250cm9sbGVyJztcbmltcG9ydCB7IHRyYW5zZm9ybUNsYXNzTmFtZVRvR3JhcGhRTCB9IGZyb20gJy4uL3RyYW5zZm9ybWVycy9jbGFzc05hbWUnO1xuaW1wb3J0IHsgdHJhbnNmb3JtSW5wdXRUeXBlVG9HcmFwaFFMIH0gZnJvbSAnLi4vdHJhbnNmb3JtZXJzL2lucHV0VHlwZSc7XG5pbXBvcnQgeyB0cmFuc2Zvcm1PdXRwdXRUeXBlVG9HcmFwaFFMIH0gZnJvbSAnLi4vdHJhbnNmb3JtZXJzL291dHB1dFR5cGUnO1xuaW1wb3J0IHsgdHJhbnNmb3JtQ29uc3RyYWludFR5cGVUb0dyYXBoUUwgfSBmcm9tICcuLi90cmFuc2Zvcm1lcnMvY29uc3RyYWludFR5cGUnO1xuaW1wb3J0IHtcbiAgZXh0cmFjdEtleXNBbmRJbmNsdWRlLFxuICBnZXRQYXJzZUNsYXNzTXV0YXRpb25Db25maWcsXG59IGZyb20gJy4uL3BhcnNlR3JhcGhRTFV0aWxzJztcblxuY29uc3QgZ2V0UGFyc2VDbGFzc1R5cGVDb25maWcgPSBmdW5jdGlvbihcbiAgcGFyc2VDbGFzc0NvbmZpZzogP1BhcnNlR3JhcGhRTENsYXNzQ29uZmlnXG4pIHtcbiAgcmV0dXJuIChwYXJzZUNsYXNzQ29uZmlnICYmIHBhcnNlQ2xhc3NDb25maWcudHlwZSkgfHwge307XG59O1xuXG5jb25zdCBnZXRJbnB1dEZpZWxkc0FuZENvbnN0cmFpbnRzID0gZnVuY3Rpb24oXG4gIHBhcnNlQ2xhc3MsXG4gIHBhcnNlQ2xhc3NDb25maWc6ID9QYXJzZUdyYXBoUUxDbGFzc0NvbmZpZ1xuKSB7XG4gIGNvbnN0IGNsYXNzRmllbGRzID0gT2JqZWN0LmtleXMocGFyc2VDbGFzcy5maWVsZHMpXG4gICAgLmZpbHRlcihmaWVsZCA9PiBmaWVsZCAhPT0gJ29iamVjdElkJylcbiAgICAuY29uY2F0KCdpZCcpO1xuICBjb25zdCB7XG4gICAgaW5wdXRGaWVsZHM6IGFsbG93ZWRJbnB1dEZpZWxkcyxcbiAgICBvdXRwdXRGaWVsZHM6IGFsbG93ZWRPdXRwdXRGaWVsZHMsXG4gICAgY29uc3RyYWludEZpZWxkczogYWxsb3dlZENvbnN0cmFpbnRGaWVsZHMsXG4gICAgc29ydEZpZWxkczogYWxsb3dlZFNvcnRGaWVsZHMsXG4gIH0gPSBnZXRQYXJzZUNsYXNzVHlwZUNvbmZpZyhwYXJzZUNsYXNzQ29uZmlnKTtcblxuICBsZXQgY2xhc3NPdXRwdXRGaWVsZHM7XG4gIGxldCBjbGFzc0NyZWF0ZUZpZWxkcztcbiAgbGV0IGNsYXNzVXBkYXRlRmllbGRzO1xuICBsZXQgY2xhc3NDb25zdHJhaW50RmllbGRzO1xuICBsZXQgY2xhc3NTb3J0RmllbGRzO1xuXG4gIC8vIEFsbCBhbGxvd2VkIGN1c3RvbXMgZmllbGRzXG4gIGNvbnN0IGNsYXNzQ3VzdG9tRmllbGRzID0gY2xhc3NGaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICByZXR1cm4gIU9iamVjdC5rZXlzKGRlZmF1bHRHcmFwaFFMVHlwZXMuUEFSU0VfT0JKRUNUX0ZJRUxEUykuaW5jbHVkZXMoXG4gICAgICBmaWVsZFxuICAgICk7XG4gIH0pO1xuXG4gIGlmIChhbGxvd2VkSW5wdXRGaWVsZHMgJiYgYWxsb3dlZElucHV0RmllbGRzLmNyZWF0ZSkge1xuICAgIGNsYXNzQ3JlYXRlRmllbGRzID0gY2xhc3NDdXN0b21GaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIHJldHVybiBhbGxvd2VkSW5wdXRGaWVsZHMuY3JlYXRlLmluY2x1ZGVzKGZpZWxkKTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICBjbGFzc0NyZWF0ZUZpZWxkcyA9IGNsYXNzQ3VzdG9tRmllbGRzO1xuICB9XG4gIGlmIChhbGxvd2VkSW5wdXRGaWVsZHMgJiYgYWxsb3dlZElucHV0RmllbGRzLnVwZGF0ZSkge1xuICAgIGNsYXNzVXBkYXRlRmllbGRzID0gY2xhc3NDdXN0b21GaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIHJldHVybiBhbGxvd2VkSW5wdXRGaWVsZHMudXBkYXRlLmluY2x1ZGVzKGZpZWxkKTtcbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICBjbGFzc1VwZGF0ZUZpZWxkcyA9IGNsYXNzQ3VzdG9tRmllbGRzO1xuICB9XG5cbiAgaWYgKGFsbG93ZWRPdXRwdXRGaWVsZHMpIHtcbiAgICBjbGFzc091dHB1dEZpZWxkcyA9IGNsYXNzQ3VzdG9tRmllbGRzLmZpbHRlcihmaWVsZCA9PiB7XG4gICAgICByZXR1cm4gYWxsb3dlZE91dHB1dEZpZWxkcy5pbmNsdWRlcyhmaWVsZCk7XG4gICAgfSk7XG4gIH0gZWxzZSB7XG4gICAgY2xhc3NPdXRwdXRGaWVsZHMgPSBjbGFzc0N1c3RvbUZpZWxkcztcbiAgfVxuICAvLyBGaWx0ZXJzIHRoZSBcInBhc3N3b3JkXCIgZmllbGQgZnJvbSBjbGFzcyBfVXNlclxuICBpZiAocGFyc2VDbGFzcy5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBjbGFzc091dHB1dEZpZWxkcyA9IGNsYXNzT3V0cHV0RmllbGRzLmZpbHRlcihcbiAgICAgIG91dHB1dEZpZWxkID0+IG91dHB1dEZpZWxkICE9PSAncGFzc3dvcmQnXG4gICAgKTtcbiAgfVxuXG4gIGlmIChhbGxvd2VkQ29uc3RyYWludEZpZWxkcykge1xuICAgIGNsYXNzQ29uc3RyYWludEZpZWxkcyA9IGNsYXNzQ3VzdG9tRmllbGRzLmZpbHRlcihmaWVsZCA9PiB7XG4gICAgICByZXR1cm4gYWxsb3dlZENvbnN0cmFpbnRGaWVsZHMuaW5jbHVkZXMoZmllbGQpO1xuICAgIH0pO1xuICB9IGVsc2Uge1xuICAgIGNsYXNzQ29uc3RyYWludEZpZWxkcyA9IGNsYXNzRmllbGRzO1xuICB9XG5cbiAgaWYgKGFsbG93ZWRTb3J0RmllbGRzKSB7XG4gICAgY2xhc3NTb3J0RmllbGRzID0gYWxsb3dlZFNvcnRGaWVsZHM7XG4gICAgaWYgKCFjbGFzc1NvcnRGaWVsZHMubGVuZ3RoKSB7XG4gICAgICAvLyBtdXN0IGhhdmUgYXQgbGVhc3QgMSBvcmRlciBmaWVsZFxuICAgICAgLy8gb3RoZXJ3aXNlIHRoZSBGaW5kQXJncyBJbnB1dCBUeXBlIHdpbGwgdGhyb3cuXG4gICAgICBjbGFzc1NvcnRGaWVsZHMucHVzaCh7XG4gICAgICAgIGZpZWxkOiAnaWQnLFxuICAgICAgICBhc2M6IHRydWUsXG4gICAgICAgIGRlc2M6IHRydWUsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgY2xhc3NTb3J0RmllbGRzID0gY2xhc3NGaWVsZHMubWFwKGZpZWxkID0+IHtcbiAgICAgIHJldHVybiB7IGZpZWxkLCBhc2M6IHRydWUsIGRlc2M6IHRydWUgfTtcbiAgICB9KTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgY2xhc3NDcmVhdGVGaWVsZHMsXG4gICAgY2xhc3NVcGRhdGVGaWVsZHMsXG4gICAgY2xhc3NDb25zdHJhaW50RmllbGRzLFxuICAgIGNsYXNzT3V0cHV0RmllbGRzLFxuICAgIGNsYXNzU29ydEZpZWxkcyxcbiAgfTtcbn07XG5cbmNvbnN0IGxvYWQgPSAoXG4gIHBhcnNlR3JhcGhRTFNjaGVtYSxcbiAgcGFyc2VDbGFzcyxcbiAgcGFyc2VDbGFzc0NvbmZpZzogP1BhcnNlR3JhcGhRTENsYXNzQ29uZmlnXG4pID0+IHtcbiAgY29uc3QgY2xhc3NOYW1lID0gcGFyc2VDbGFzcy5jbGFzc05hbWU7XG4gIGNvbnN0IGdyYXBoUUxDbGFzc05hbWUgPSB0cmFuc2Zvcm1DbGFzc05hbWVUb0dyYXBoUUwoY2xhc3NOYW1lKTtcbiAgY29uc3Qge1xuICAgIGNsYXNzQ3JlYXRlRmllbGRzLFxuICAgIGNsYXNzVXBkYXRlRmllbGRzLFxuICAgIGNsYXNzT3V0cHV0RmllbGRzLFxuICAgIGNsYXNzQ29uc3RyYWludEZpZWxkcyxcbiAgICBjbGFzc1NvcnRGaWVsZHMsXG4gIH0gPSBnZXRJbnB1dEZpZWxkc0FuZENvbnN0cmFpbnRzKHBhcnNlQ2xhc3MsIHBhcnNlQ2xhc3NDb25maWcpO1xuXG4gIGNvbnN0IHtcbiAgICBjcmVhdGU6IGlzQ3JlYXRlRW5hYmxlZCA9IHRydWUsXG4gICAgdXBkYXRlOiBpc1VwZGF0ZUVuYWJsZWQgPSB0cnVlLFxuICB9ID0gZ2V0UGFyc2VDbGFzc011dGF0aW9uQ29uZmlnKHBhcnNlQ2xhc3NDb25maWcpO1xuXG4gIGNvbnN0IGNsYXNzR3JhcGhRTENyZWF0ZVR5cGVOYW1lID0gYENyZWF0ZSR7Z3JhcGhRTENsYXNzTmFtZX1GaWVsZHNJbnB1dGA7XG4gIGxldCBjbGFzc0dyYXBoUUxDcmVhdGVUeXBlID0gbmV3IEdyYXBoUUxJbnB1dE9iamVjdFR5cGUoe1xuICAgIG5hbWU6IGNsYXNzR3JhcGhRTENyZWF0ZVR5cGVOYW1lLFxuICAgIGRlc2NyaXB0aW9uOiBgVGhlICR7Y2xhc3NHcmFwaFFMQ3JlYXRlVHlwZU5hbWV9IGlucHV0IHR5cGUgaXMgdXNlZCBpbiBvcGVyYXRpb25zIHRoYXQgaW52b2x2ZSBjcmVhdGlvbiBvZiBvYmplY3RzIGluIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzLmAsXG4gICAgZmllbGRzOiAoKSA9PlxuICAgICAgY2xhc3NDcmVhdGVGaWVsZHMucmVkdWNlKFxuICAgICAgICAoZmllbGRzLCBmaWVsZCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHR5cGUgPSB0cmFuc2Zvcm1JbnB1dFR5cGVUb0dyYXBoUUwoXG4gICAgICAgICAgICBwYXJzZUNsYXNzLmZpZWxkc1tmaWVsZF0udHlwZSxcbiAgICAgICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50YXJnZXRDbGFzcyxcbiAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5wYXJzZUNsYXNzVHlwZXNcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICh0eXBlKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgICAgIFtmaWVsZF06IHtcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogYFRoaXMgaXMgdGhlIG9iamVjdCAke2ZpZWxkfS5gLFxuICAgICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gZmllbGRzO1xuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIEFDTDogZGVmYXVsdEdyYXBoUUxUeXBlcy5BQ0xfQVRULFxuICAgICAgICB9XG4gICAgICApLFxuICB9KTtcbiAgY2xhc3NHcmFwaFFMQ3JlYXRlVHlwZSA9IHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShcbiAgICBjbGFzc0dyYXBoUUxDcmVhdGVUeXBlXG4gICk7XG5cbiAgY29uc3QgY2xhc3NHcmFwaFFMVXBkYXRlVHlwZU5hbWUgPSBgVXBkYXRlJHtncmFwaFFMQ2xhc3NOYW1lfUZpZWxkc0lucHV0YDtcbiAgbGV0IGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGUgPSBuZXcgR3JhcGhRTElucHV0T2JqZWN0VHlwZSh7XG4gICAgbmFtZTogY2xhc3NHcmFwaFFMVXBkYXRlVHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBUaGUgJHtjbGFzc0dyYXBoUUxVcGRhdGVUeXBlTmFtZX0gaW5wdXQgdHlwZSBpcyB1c2VkIGluIG9wZXJhdGlvbnMgdGhhdCBpbnZvbHZlIGNyZWF0aW9uIG9mIG9iamVjdHMgaW4gdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3MuYCxcbiAgICBmaWVsZHM6ICgpID0+XG4gICAgICBjbGFzc1VwZGF0ZUZpZWxkcy5yZWR1Y2UoXG4gICAgICAgIChmaWVsZHMsIGZpZWxkKSA9PiB7XG4gICAgICAgICAgY29uc3QgdHlwZSA9IHRyYW5zZm9ybUlucHV0VHlwZVRvR3JhcGhRTChcbiAgICAgICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50eXBlLFxuICAgICAgICAgICAgcGFyc2VDbGFzcy5maWVsZHNbZmllbGRdLnRhcmdldENsYXNzLFxuICAgICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLnBhcnNlQ2xhc3NUeXBlc1xuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKHR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIC4uLmZpZWxkcyxcbiAgICAgICAgICAgICAgW2ZpZWxkXToge1xuICAgICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgVGhpcyBpcyB0aGUgb2JqZWN0ICR7ZmllbGR9LmAsXG4gICAgICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBmaWVsZHM7XG4gICAgICAgICAgfVxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgQUNMOiBkZWZhdWx0R3JhcGhRTFR5cGVzLkFDTF9BVFQsXG4gICAgICAgIH1cbiAgICAgICksXG4gIH0pO1xuICBjbGFzc0dyYXBoUUxVcGRhdGVUeXBlID0gcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGVcbiAgKTtcblxuICBjb25zdCBjbGFzc0dyYXBoUUxQb2ludGVyVHlwZU5hbWUgPSBgJHtncmFwaFFMQ2xhc3NOYW1lfVBvaW50ZXJJbnB1dGA7XG4gIGxldCBjbGFzc0dyYXBoUUxQb2ludGVyVHlwZSA9IG5ldyBHcmFwaFFMSW5wdXRPYmplY3RUeXBlKHtcbiAgICBuYW1lOiBjbGFzc0dyYXBoUUxQb2ludGVyVHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBBbGxvdyB0byBsaW5rIE9SIGFkZCBhbmQgbGluayBhbiBvYmplY3Qgb2YgdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3MuYCxcbiAgICBmaWVsZHM6ICgpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkcyA9IHtcbiAgICAgICAgbGluazoge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgTGluayBhbiBleGlzdGluZyBvYmplY3QgZnJvbSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzLmAsXG4gICAgICAgICAgdHlwZTogR3JhcGhRTElELFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICAgIGlmIChpc0NyZWF0ZUVuYWJsZWQpIHtcbiAgICAgICAgZmllbGRzWydjcmVhdGVBbmRMaW5rJ10gPSB7XG4gICAgICAgICAgZGVzY3JpcHRpb246IGBDcmVhdGUgYW5kIGxpbmsgYW4gb2JqZWN0IGZyb20gJHtncmFwaFFMQ2xhc3NOYW1lfSBjbGFzcy5gLFxuICAgICAgICAgIHR5cGU6IGNsYXNzR3JhcGhRTENyZWF0ZVR5cGUsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gZmllbGRzO1xuICAgIH0sXG4gIH0pO1xuICBjbGFzc0dyYXBoUUxQb2ludGVyVHlwZSA9XG4gICAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKGNsYXNzR3JhcGhRTFBvaW50ZXJUeXBlKSB8fFxuICAgIGRlZmF1bHRHcmFwaFFMVHlwZXMuT0JKRUNUO1xuXG4gIGNvbnN0IGNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZU5hbWUgPSBgJHtncmFwaFFMQ2xhc3NOYW1lfVJlbGF0aW9uSW5wdXRgO1xuICBsZXQgY2xhc3NHcmFwaFFMUmVsYXRpb25UeXBlID0gbmV3IEdyYXBoUUxJbnB1dE9iamVjdFR5cGUoe1xuICAgIG5hbWU6IGNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBBbGxvdyB0byBhZGQsIHJlbW92ZSwgY3JlYXRlQW5kQWRkIG9iamVjdHMgb2YgdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3MgaW50byBhIHJlbGF0aW9uIGZpZWxkLmAsXG4gICAgZmllbGRzOiAoKSA9PiB7XG4gICAgICBjb25zdCBmaWVsZHMgPSB7XG4gICAgICAgIGFkZDoge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgQWRkIGFuIGV4aXN0aW5nIG9iamVjdCBmcm9tIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzIGludG8gdGhlIHJlbGF0aW9uLmAsXG4gICAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxMaXN0KGRlZmF1bHRHcmFwaFFMVHlwZXMuT0JKRUNUX0lEKSxcbiAgICAgICAgfSxcbiAgICAgICAgcmVtb3ZlOiB7XG4gICAgICAgICAgZGVzY3JpcHRpb246IGBSZW1vdmUgYW4gZXhpc3Rpbmcgb2JqZWN0IGZyb20gdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3Mgb3V0IG9mIHRoZSByZWxhdGlvbi5gLFxuICAgICAgICAgIHR5cGU6IG5ldyBHcmFwaFFMTGlzdChkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVF9JRCksXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgICAgaWYgKGlzQ3JlYXRlRW5hYmxlZCkge1xuICAgICAgICBmaWVsZHNbJ2NyZWF0ZUFuZEFkZCddID0ge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiBgQ3JlYXRlIGFuZCBhZGQgYW4gb2JqZWN0IG9mIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzIGludG8gdGhlIHJlbGF0aW9uLmAsXG4gICAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxMaXN0KG5ldyBHcmFwaFFMTm9uTnVsbChjbGFzc0dyYXBoUUxDcmVhdGVUeXBlKSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gZmllbGRzO1xuICAgIH0sXG4gIH0pO1xuICBjbGFzc0dyYXBoUUxSZWxhdGlvblR5cGUgPVxuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShjbGFzc0dyYXBoUUxSZWxhdGlvblR5cGUpIHx8XG4gICAgZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1Q7XG5cbiAgY29uc3QgY2xhc3NHcmFwaFFMQ29uc3RyYWludFR5cGVOYW1lID0gYCR7Z3JhcGhRTENsYXNzTmFtZX1Qb2ludGVyV2hlcmVJbnB1dGA7XG4gIGxldCBjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZSA9IG5ldyBHcmFwaFFMSW5wdXRPYmplY3RUeXBlKHtcbiAgICBuYW1lOiBjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBUaGUgJHtjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZU5hbWV9IGlucHV0IHR5cGUgaXMgdXNlZCBpbiBvcGVyYXRpb25zIHRoYXQgaW52b2x2ZSBmaWx0ZXJpbmcgb2JqZWN0cyBieSBhIHBvaW50ZXIgZmllbGQgdG8gJHtncmFwaFFMQ2xhc3NOYW1lfSBjbGFzcy5gLFxuICAgIGZpZWxkczoge1xuICAgICAgZXF1YWxUbzogZGVmYXVsdEdyYXBoUUxUeXBlcy5lcXVhbFRvKEdyYXBoUUxJRCksXG4gICAgICBub3RFcXVhbFRvOiBkZWZhdWx0R3JhcGhRTFR5cGVzLm5vdEVxdWFsVG8oR3JhcGhRTElEKSxcbiAgICAgIGluOiBkZWZhdWx0R3JhcGhRTFR5cGVzLmluT3AoZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1RfSUQpLFxuICAgICAgbm90SW46IGRlZmF1bHRHcmFwaFFMVHlwZXMubm90SW4oZGVmYXVsdEdyYXBoUUxUeXBlcy5PQkpFQ1RfSUQpLFxuICAgICAgZXhpc3RzOiBkZWZhdWx0R3JhcGhRTFR5cGVzLmV4aXN0cyxcbiAgICAgIGluUXVlcnlLZXk6IGRlZmF1bHRHcmFwaFFMVHlwZXMuaW5RdWVyeUtleSxcbiAgICAgIG5vdEluUXVlcnlLZXk6IGRlZmF1bHRHcmFwaFFMVHlwZXMubm90SW5RdWVyeUtleSxcbiAgICAgIGluUXVlcnk6IHtcbiAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgJ1RoaXMgaXMgdGhlIGluUXVlcnkgb3BlcmF0b3IgdG8gc3BlY2lmeSBhIGNvbnN0cmFpbnQgdG8gc2VsZWN0IHRoZSBvYmplY3RzIHdoZXJlIGEgZmllbGQgZXF1YWxzIHRvIGFueSBvZiB0aGUgaWRzIGluIHRoZSByZXN1bHQgb2YgYSBkaWZmZXJlbnQgcXVlcnkuJyxcbiAgICAgICAgdHlwZTogZGVmYXVsdEdyYXBoUUxUeXBlcy5TVUJRVUVSWV9JTlBVVCxcbiAgICAgIH0sXG4gICAgICBub3RJblF1ZXJ5OiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICdUaGlzIGlzIHRoZSBub3RJblF1ZXJ5IG9wZXJhdG9yIHRvIHNwZWNpZnkgYSBjb25zdHJhaW50IHRvIHNlbGVjdCB0aGUgb2JqZWN0cyB3aGVyZSBhIGZpZWxkIGRvIG5vdCBlcXVhbCB0byBhbnkgb2YgdGhlIGlkcyBpbiB0aGUgcmVzdWx0IG9mIGEgZGlmZmVyZW50IHF1ZXJ5LicsXG4gICAgICAgIHR5cGU6IGRlZmF1bHRHcmFwaFFMVHlwZXMuU1VCUVVFUllfSU5QVVQsXG4gICAgICB9LFxuICAgIH0sXG4gIH0pO1xuICBjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZSA9IHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShcbiAgICBjbGFzc0dyYXBoUUxDb25zdHJhaW50VHlwZVxuICApO1xuXG4gIGNvbnN0IGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZU5hbWUgPSBgJHtncmFwaFFMQ2xhc3NOYW1lfVdoZXJlSW5wdXRgO1xuICBsZXQgY2xhc3NHcmFwaFFMQ29uc3RyYWludHNUeXBlID0gbmV3IEdyYXBoUUxJbnB1dE9iamVjdFR5cGUoe1xuICAgIG5hbWU6IGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBUaGUgJHtjbGFzc0dyYXBoUUxDb25zdHJhaW50c1R5cGVOYW1lfSBpbnB1dCB0eXBlIGlzIHVzZWQgaW4gb3BlcmF0aW9ucyB0aGF0IGludm9sdmUgZmlsdGVyaW5nIG9iamVjdHMgb2YgJHtncmFwaFFMQ2xhc3NOYW1lfSBjbGFzcy5gLFxuICAgIGZpZWxkczogKCkgPT4gKHtcbiAgICAgIC4uLmNsYXNzQ29uc3RyYWludEZpZWxkcy5yZWR1Y2UoKGZpZWxkcywgZmllbGQpID0+IHtcbiAgICAgICAgaWYgKFsnT1InLCAnQU5EJywgJ05PUiddLmluY2x1ZGVzKGZpZWxkKSkge1xuICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5sb2cud2FybihcbiAgICAgICAgICAgIGBGaWVsZCAke2ZpZWxkfSBjb3VsZCBub3QgYmUgYWRkZWQgdG8gdGhlIGF1dG8gc2NoZW1hICR7Y2xhc3NHcmFwaFFMQ29uc3RyYWludHNUeXBlTmFtZX0gYmVjYXVzZSBpdCBjb2xsaWRlZCB3aXRoIGFuIGV4aXN0aW5nIG9uZS5gXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm4gZmllbGRzO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHBhcnNlRmllbGQgPSBmaWVsZCA9PT0gJ2lkJyA/ICdvYmplY3RJZCcgOiBmaWVsZDtcbiAgICAgICAgY29uc3QgdHlwZSA9IHRyYW5zZm9ybUNvbnN0cmFpbnRUeXBlVG9HcmFwaFFMKFxuICAgICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW3BhcnNlRmllbGRdLnR5cGUsXG4gICAgICAgICAgcGFyc2VDbGFzcy5maWVsZHNbcGFyc2VGaWVsZF0udGFyZ2V0Q2xhc3MsXG4gICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLnBhcnNlQ2xhc3NUeXBlc1xuICAgICAgICApO1xuICAgICAgICBpZiAodHlwZSkge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgICBbZmllbGRdOiB7XG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgVGhpcyBpcyB0aGUgb2JqZWN0ICR7ZmllbGR9LmAsXG4gICAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIGZpZWxkcztcbiAgICAgICAgfVxuICAgICAgfSwge30pLFxuICAgICAgT1I6IHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdUaGlzIGlzIHRoZSBPUiBvcGVyYXRvciB0byBjb21wb3VuZCBjb25zdHJhaW50cy4nLFxuICAgICAgICB0eXBlOiBuZXcgR3JhcGhRTExpc3QobmV3IEdyYXBoUUxOb25OdWxsKGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZSkpLFxuICAgICAgfSxcbiAgICAgIEFORDoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIEFORCBvcGVyYXRvciB0byBjb21wb3VuZCBjb25zdHJhaW50cy4nLFxuICAgICAgICB0eXBlOiBuZXcgR3JhcGhRTExpc3QobmV3IEdyYXBoUUxOb25OdWxsKGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZSkpLFxuICAgICAgfSxcbiAgICAgIE5PUjoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIE5PUiBvcGVyYXRvciB0byBjb21wb3VuZCBjb25zdHJhaW50cy4nLFxuICAgICAgICB0eXBlOiBuZXcgR3JhcGhRTExpc3QobmV3IEdyYXBoUUxOb25OdWxsKGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZSkpLFxuICAgICAgfSxcbiAgICB9KSxcbiAgfSk7XG4gIGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZSA9XG4gICAgcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKGNsYXNzR3JhcGhRTENvbnN0cmFpbnRzVHlwZSkgfHxcbiAgICBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVDtcblxuICBjb25zdCBjbGFzc0dyYXBoUUxPcmRlclR5cGVOYW1lID0gYCR7Z3JhcGhRTENsYXNzTmFtZX1PcmRlcmA7XG4gIGxldCBjbGFzc0dyYXBoUUxPcmRlclR5cGUgPSBuZXcgR3JhcGhRTEVudW1UeXBlKHtcbiAgICBuYW1lOiBjbGFzc0dyYXBoUUxPcmRlclR5cGVOYW1lLFxuICAgIGRlc2NyaXB0aW9uOiBgVGhlICR7Y2xhc3NHcmFwaFFMT3JkZXJUeXBlTmFtZX0gaW5wdXQgdHlwZSBpcyB1c2VkIHdoZW4gc29ydGluZyBvYmplY3RzIG9mIHRoZSAke2dyYXBoUUxDbGFzc05hbWV9IGNsYXNzLmAsXG4gICAgdmFsdWVzOiBjbGFzc1NvcnRGaWVsZHMucmVkdWNlKChzb3J0RmllbGRzLCBmaWVsZENvbmZpZykgPT4ge1xuICAgICAgY29uc3QgeyBmaWVsZCwgYXNjLCBkZXNjIH0gPSBmaWVsZENvbmZpZztcbiAgICAgIGNvbnN0IHVwZGF0ZWRTb3J0RmllbGRzID0ge1xuICAgICAgICAuLi5zb3J0RmllbGRzLFxuICAgICAgfTtcbiAgICAgIGlmIChhc2MpIHtcbiAgICAgICAgdXBkYXRlZFNvcnRGaWVsZHNbYCR7ZmllbGR9X0FTQ2BdID0geyB2YWx1ZTogZmllbGQgfTtcbiAgICAgIH1cbiAgICAgIGlmIChkZXNjKSB7XG4gICAgICAgIHVwZGF0ZWRTb3J0RmllbGRzW2Ake2ZpZWxkfV9ERVNDYF0gPSB7IHZhbHVlOiBgLSR7ZmllbGR9YCB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVwZGF0ZWRTb3J0RmllbGRzO1xuICAgIH0sIHt9KSxcbiAgfSk7XG4gIGNsYXNzR3JhcGhRTE9yZGVyVHlwZSA9IHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShcbiAgICBjbGFzc0dyYXBoUUxPcmRlclR5cGVcbiAgKTtcblxuICBjb25zdCBjbGFzc0dyYXBoUUxGaW5kQXJncyA9IHtcbiAgICB3aGVyZToge1xuICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICdUaGVzZSBhcmUgdGhlIGNvbmRpdGlvbnMgdGhhdCB0aGUgb2JqZWN0cyBuZWVkIHRvIG1hdGNoIGluIG9yZGVyIHRvIGJlIGZvdW5kLicsXG4gICAgICB0eXBlOiBjbGFzc0dyYXBoUUxDb25zdHJhaW50c1R5cGUsXG4gICAgfSxcbiAgICBvcmRlcjoge1xuICAgICAgZGVzY3JpcHRpb246ICdUaGUgZmllbGRzIHRvIGJlIHVzZWQgd2hlbiBzb3J0aW5nIHRoZSBkYXRhIGZldGNoZWQuJyxcbiAgICAgIHR5cGU6IGNsYXNzR3JhcGhRTE9yZGVyVHlwZVxuICAgICAgICA/IG5ldyBHcmFwaFFMTGlzdChuZXcgR3JhcGhRTE5vbk51bGwoY2xhc3NHcmFwaFFMT3JkZXJUeXBlKSlcbiAgICAgICAgOiBHcmFwaFFMU3RyaW5nLFxuICAgIH0sXG4gICAgc2tpcDogZGVmYXVsdEdyYXBoUUxUeXBlcy5TS0lQX0FUVCxcbiAgICBsaW1pdDogZGVmYXVsdEdyYXBoUUxUeXBlcy5MSU1JVF9BVFQsXG4gICAgb3B0aW9uczogZGVmYXVsdEdyYXBoUUxUeXBlcy5SRUFEX09QVElPTlNfQVRULFxuICB9O1xuXG4gIGNvbnN0IGNsYXNzR3JhcGhRTE91dHB1dFR5cGVOYW1lID0gYCR7Z3JhcGhRTENsYXNzTmFtZX1gO1xuICBjb25zdCBvdXRwdXRGaWVsZHMgPSAoKSA9PiB7XG4gICAgcmV0dXJuIGNsYXNzT3V0cHV0RmllbGRzLnJlZHVjZSgoZmllbGRzLCBmaWVsZCkgPT4ge1xuICAgICAgY29uc3QgdHlwZSA9IHRyYW5zZm9ybU91dHB1dFR5cGVUb0dyYXBoUUwoXG4gICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50eXBlLFxuICAgICAgICBwYXJzZUNsYXNzLmZpZWxkc1tmaWVsZF0udGFyZ2V0Q2xhc3MsXG4gICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5wYXJzZUNsYXNzVHlwZXNcbiAgICAgICk7XG4gICAgICBpZiAocGFyc2VDbGFzcy5maWVsZHNbZmllbGRdLnR5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgY29uc3QgdGFyZ2V0UGFyc2VDbGFzc1R5cGVzID1cbiAgICAgICAgICBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc1R5cGVzW1xuICAgICAgICAgICAgcGFyc2VDbGFzcy5maWVsZHNbZmllbGRdLnRhcmdldENsYXNzXG4gICAgICAgICAgXTtcbiAgICAgICAgY29uc3QgYXJncyA9IHRhcmdldFBhcnNlQ2xhc3NUeXBlc1xuICAgICAgICAgID8gdGFyZ2V0UGFyc2VDbGFzc1R5cGVzLmNsYXNzR3JhcGhRTEZpbmRBcmdzXG4gICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uZmllbGRzLFxuICAgICAgICAgIFtmaWVsZF06IHtcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBgVGhpcyBpcyB0aGUgb2JqZWN0ICR7ZmllbGR9LmAsXG4gICAgICAgICAgICBhcmdzLFxuICAgICAgICAgICAgdHlwZSxcbiAgICAgICAgICAgIGFzeW5jIHJlc29sdmUoc291cmNlLCBhcmdzLCBjb250ZXh0LCBxdWVyeUluZm8pIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCB7IHdoZXJlLCBvcmRlciwgc2tpcCwgbGltaXQsIG9wdGlvbnMgfSA9IGFyZ3M7XG4gICAgICAgICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgICAgICBpbmNsdWRlUmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgICAgICBzdWJxdWVyeVJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgICAgICAgIH0gPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGNvbnN0IHsgY29uZmlnLCBhdXRoLCBpbmZvIH0gPSBjb250ZXh0O1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkRmllbGRzID0gZ2V0RmllbGROYW1lcyhxdWVyeUluZm8pO1xuXG4gICAgICAgICAgICAgICAgY29uc3QgeyBrZXlzLCBpbmNsdWRlIH0gPSBleHRyYWN0S2V5c0FuZEluY2x1ZGUoXG4gICAgICAgICAgICAgICAgICBzZWxlY3RlZEZpZWxkc1xuICAgICAgICAgICAgICAgICAgICAuZmlsdGVyKGZpZWxkID0+IGZpZWxkLmluY2x1ZGVzKCcuJykpXG4gICAgICAgICAgICAgICAgICAgIC5tYXAoZmllbGQgPT4gZmllbGQuc2xpY2UoZmllbGQuaW5kZXhPZignLicpICsgMSkpXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgb2JqZWN0c1F1ZXJpZXMuZmluZE9iamVjdHMoXG4gICAgICAgICAgICAgICAgICBzb3VyY2VbZmllbGRdLmNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgJHJlbGF0ZWRUbzoge1xuICAgICAgICAgICAgICAgICAgICAgIG9iamVjdDoge1xuICAgICAgICAgICAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU6IGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdElkOiBzb3VyY2Uub2JqZWN0SWQsXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICBrZXk6IGZpZWxkLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAuLi4od2hlcmUgfHwge30pLFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIG9yZGVyLFxuICAgICAgICAgICAgICAgICAgc2tpcCxcbiAgICAgICAgICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgICAgICAgICAga2V5cyxcbiAgICAgICAgICAgICAgICAgIGluY2x1ZGUsXG4gICAgICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgICAgICAgICAgaW5jbHVkZVJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgICAgICAgICAgc3VicXVlcnlSZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICAgICAgICAgIGNvbmZpZyxcbiAgICAgICAgICAgICAgICAgIGF1dGgsXG4gICAgICAgICAgICAgICAgICBpbmZvLFxuICAgICAgICAgICAgICAgICAgc2VsZWN0ZWRGaWVsZHMubWFwKGZpZWxkID0+IGZpZWxkLnNwbGl0KCcuJywgMSlbMF0pLFxuICAgICAgICAgICAgICAgICAgcGFyc2VDbGFzcy5maWVsZHNcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgcGFyc2VHcmFwaFFMU2NoZW1hLmhhbmRsZUVycm9yKGUpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgW2ZpZWxkXToge1xuICAgICAgICAgICAgZGVzY3JpcHRpb246IGBUaGlzIGlzIHRoZSBvYmplY3QgJHtmaWVsZH0uYCxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgICBhc3luYyByZXNvbHZlKHNvdXJjZSkge1xuICAgICAgICAgICAgICBpZiAoc291cmNlW2ZpZWxkXSAmJiBzb3VyY2VbZmllbGRdLmNvb3JkaW5hdGVzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNvdXJjZVtmaWVsZF0uY29vcmRpbmF0ZXMubWFwKGNvb3JkaW5hdGUgPT4gKHtcbiAgICAgICAgICAgICAgICAgIGxhdGl0dWRlOiBjb29yZGluYXRlWzBdLFxuICAgICAgICAgICAgICAgICAgbG9uZ2l0dWRlOiBjb29yZGluYXRlWzFdLFxuICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIGlmIChwYXJzZUNsYXNzLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ0FycmF5Jykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIC4uLmZpZWxkcyxcbiAgICAgICAgICBbZmllbGRdOiB7XG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogYFVzZSBJbmxpbmUgRnJhZ21lbnQgb24gQXJyYXkgdG8gZ2V0IHJlc3VsdHM6IGh0dHBzOi8vZ3JhcGhxbC5vcmcvbGVhcm4vcXVlcmllcy8jaW5saW5lLWZyYWdtZW50c2AsXG4gICAgICAgICAgICB0eXBlLFxuICAgICAgICAgICAgYXN5bmMgcmVzb2x2ZShzb3VyY2UpIHtcbiAgICAgICAgICAgICAgaWYgKCFzb3VyY2VbZmllbGRdKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgcmV0dXJuIHNvdXJjZVtmaWVsZF0ubWFwKGFzeW5jIGVsZW0gPT4ge1xuICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgIGVsZW0uY2xhc3NOYW1lICYmXG4gICAgICAgICAgICAgICAgICBlbGVtLm9iamVjdElkICYmXG4gICAgICAgICAgICAgICAgICBlbGVtLl9fdHlwZSA9PT0gJ09iamVjdCdcbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBlbGVtO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4geyB2YWx1ZTogZWxlbSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHR5cGUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgW2ZpZWxkXToge1xuICAgICAgICAgICAgZGVzY3JpcHRpb246IGBUaGlzIGlzIHRoZSBvYmplY3QgJHtmaWVsZH0uYCxcbiAgICAgICAgICAgIHR5cGUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmaWVsZHM7XG4gICAgICB9XG4gICAgfSwgZGVmYXVsdEdyYXBoUUxUeXBlcy5QQVJTRV9PQkpFQ1RfRklFTERTKTtcbiAgfTtcbiAgbGV0IGNsYXNzR3JhcGhRTE91dHB1dFR5cGUgPSBuZXcgR3JhcGhRTE9iamVjdFR5cGUoe1xuICAgIG5hbWU6IGNsYXNzR3JhcGhRTE91dHB1dFR5cGVOYW1lLFxuICAgIGRlc2NyaXB0aW9uOiBgVGhlICR7Y2xhc3NHcmFwaFFMT3V0cHV0VHlwZU5hbWV9IG9iamVjdCB0eXBlIGlzIHVzZWQgaW4gb3BlcmF0aW9ucyB0aGF0IGludm9sdmUgb3V0cHV0dGluZyBvYmplY3RzIG9mICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3MuYCxcbiAgICBpbnRlcmZhY2VzOiBbZGVmYXVsdEdyYXBoUUxUeXBlcy5QQVJTRV9PQkpFQ1RdLFxuICAgIGZpZWxkczogb3V0cHV0RmllbGRzLFxuICB9KTtcbiAgY2xhc3NHcmFwaFFMT3V0cHV0VHlwZSA9IHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZShcbiAgICBjbGFzc0dyYXBoUUxPdXRwdXRUeXBlXG4gICk7XG5cbiAgY29uc3QgY2xhc3NHcmFwaFFMRmluZFJlc3VsdFR5cGVOYW1lID0gYCR7Z3JhcGhRTENsYXNzTmFtZX1GaW5kUmVzdWx0YDtcbiAgbGV0IGNsYXNzR3JhcGhRTEZpbmRSZXN1bHRUeXBlID0gbmV3IEdyYXBoUUxPYmplY3RUeXBlKHtcbiAgICBuYW1lOiBjbGFzc0dyYXBoUUxGaW5kUmVzdWx0VHlwZU5hbWUsXG4gICAgZGVzY3JpcHRpb246IGBUaGUgJHtjbGFzc0dyYXBoUUxGaW5kUmVzdWx0VHlwZU5hbWV9IG9iamVjdCB0eXBlIGlzIHVzZWQgaW4gdGhlICR7Z3JhcGhRTENsYXNzTmFtZX0gZmluZCBxdWVyeSB0byByZXR1cm4gdGhlIGRhdGEgb2YgdGhlIG1hdGNoZWQgb2JqZWN0cy5gLFxuICAgIGZpZWxkczoge1xuICAgICAgcmVzdWx0czoge1xuICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIG9iamVjdHMgcmV0dXJuZWQgYnkgdGhlIHF1ZXJ5JyxcbiAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKFxuICAgICAgICAgIG5ldyBHcmFwaFFMTGlzdChcbiAgICAgICAgICAgIG5ldyBHcmFwaFFMTm9uTnVsbChcbiAgICAgICAgICAgICAgY2xhc3NHcmFwaFFMT3V0cHV0VHlwZSB8fCBkZWZhdWx0R3JhcGhRTFR5cGVzLk9CSkVDVFxuICAgICAgICAgICAgKVxuICAgICAgICAgIClcbiAgICAgICAgKSxcbiAgICAgIH0sXG4gICAgICBjb3VudDogZGVmYXVsdEdyYXBoUUxUeXBlcy5DT1VOVF9BVFQsXG4gICAgfSxcbiAgfSk7XG4gIGNsYXNzR3JhcGhRTEZpbmRSZXN1bHRUeXBlID0gcGFyc2VHcmFwaFFMU2NoZW1hLmFkZEdyYXBoUUxUeXBlKFxuICAgIGNsYXNzR3JhcGhRTEZpbmRSZXN1bHRUeXBlXG4gICk7XG5cbiAgcGFyc2VHcmFwaFFMU2NoZW1hLnBhcnNlQ2xhc3NUeXBlc1tjbGFzc05hbWVdID0ge1xuICAgIGNsYXNzR3JhcGhRTFBvaW50ZXJUeXBlLFxuICAgIGNsYXNzR3JhcGhRTFJlbGF0aW9uVHlwZSxcbiAgICBjbGFzc0dyYXBoUUxDcmVhdGVUeXBlLFxuICAgIGNsYXNzR3JhcGhRTFVwZGF0ZVR5cGUsXG4gICAgY2xhc3NHcmFwaFFMQ29uc3RyYWludFR5cGUsXG4gICAgY2xhc3NHcmFwaFFMQ29uc3RyYWludHNUeXBlLFxuICAgIGNsYXNzR3JhcGhRTEZpbmRBcmdzLFxuICAgIGNsYXNzR3JhcGhRTE91dHB1dFR5cGUsXG4gICAgY2xhc3NHcmFwaFFMRmluZFJlc3VsdFR5cGUsXG4gICAgY29uZmlnOiB7XG4gICAgICBwYXJzZUNsYXNzQ29uZmlnLFxuICAgICAgaXNDcmVhdGVFbmFibGVkLFxuICAgICAgaXNVcGRhdGVFbmFibGVkLFxuICAgIH0sXG4gIH07XG5cbiAgaWYgKGNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIGNvbnN0IHZpZXdlclR5cGUgPSBuZXcgR3JhcGhRTE9iamVjdFR5cGUoe1xuICAgICAgbmFtZTogJ1ZpZXdlcicsXG4gICAgICBkZXNjcmlwdGlvbjogYFRoZSBWaWV3ZXIgb2JqZWN0IHR5cGUgaXMgdXNlZCBpbiBvcGVyYXRpb25zIHRoYXQgaW52b2x2ZSBvdXRwdXR0aW5nIHRoZSBjdXJyZW50IHVzZXIgZGF0YS5gLFxuICAgICAgaW50ZXJmYWNlczogW2RlZmF1bHRHcmFwaFFMVHlwZXMuUEFSU0VfT0JKRUNUXSxcbiAgICAgIGZpZWxkczogKCkgPT4gKHtcbiAgICAgICAgLi4ub3V0cHV0RmllbGRzKCksXG4gICAgICAgIHNlc3Npb25Ub2tlbjogZGVmYXVsdEdyYXBoUUxUeXBlcy5TRVNTSU9OX1RPS0VOX0FUVCxcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS52aWV3ZXJUeXBlID0gdmlld2VyVHlwZTtcbiAgICBwYXJzZUdyYXBoUUxTY2hlbWEuYWRkR3JhcGhRTFR5cGUodmlld2VyVHlwZSwgdHJ1ZSwgdHJ1ZSk7XG5cbiAgICBjb25zdCB1c2VyU2lnblVwSW5wdXRUeXBlTmFtZSA9ICdTaWduVXBGaWVsZHNJbnB1dCc7XG4gICAgY29uc3QgdXNlclNpZ25VcElucHV0VHlwZSA9IG5ldyBHcmFwaFFMSW5wdXRPYmplY3RUeXBlKHtcbiAgICAgIG5hbWU6IHVzZXJTaWduVXBJbnB1dFR5cGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246IGBUaGUgJHt1c2VyU2lnblVwSW5wdXRUeXBlTmFtZX0gaW5wdXQgdHlwZSBpcyB1c2VkIGluIG9wZXJhdGlvbnMgdGhhdCBpbnZvbHZlIGlucHV0dGluZyBvYmplY3RzIG9mICR7Z3JhcGhRTENsYXNzTmFtZX0gY2xhc3Mgd2hlbiBzaWduaW5nIHVwLmAsXG4gICAgICBmaWVsZHM6ICgpID0+XG4gICAgICAgIGNsYXNzQ3JlYXRlRmllbGRzLnJlZHVjZSgoZmllbGRzLCBmaWVsZCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHR5cGUgPSB0cmFuc2Zvcm1JbnB1dFR5cGVUb0dyYXBoUUwoXG4gICAgICAgICAgICBwYXJzZUNsYXNzLmZpZWxkc1tmaWVsZF0udHlwZSxcbiAgICAgICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkXS50YXJnZXRDbGFzcyxcbiAgICAgICAgICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5wYXJzZUNsYXNzVHlwZXNcbiAgICAgICAgICApO1xuICAgICAgICAgIGlmICh0eXBlKSB7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAuLi5maWVsZHMsXG4gICAgICAgICAgICAgIFtmaWVsZF06IHtcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogYFRoaXMgaXMgdGhlIG9iamVjdCAke2ZpZWxkfS5gLFxuICAgICAgICAgICAgICAgIHR5cGU6XG4gICAgICAgICAgICAgICAgICBmaWVsZCA9PT0gJ3VzZXJuYW1lJyB8fCBmaWVsZCA9PT0gJ3Bhc3N3b3JkJ1xuICAgICAgICAgICAgICAgICAgICA/IG5ldyBHcmFwaFFMTm9uTnVsbCh0eXBlKVxuICAgICAgICAgICAgICAgICAgICA6IHR5cGUsXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gZmllbGRzO1xuICAgICAgICAgIH1cbiAgICAgICAgfSwge30pLFxuICAgIH0pO1xuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZSh1c2VyU2lnblVwSW5wdXRUeXBlLCB0cnVlLCB0cnVlKTtcblxuICAgIGNvbnN0IHVzZXJMb2dJbklucHV0VHlwZU5hbWUgPSAnTG9nSW5GaWVsZHNJbnB1dCc7XG4gICAgY29uc3QgdXNlckxvZ0luSW5wdXRUeXBlID0gbmV3IEdyYXBoUUxJbnB1dE9iamVjdFR5cGUoe1xuICAgICAgbmFtZTogdXNlckxvZ0luSW5wdXRUeXBlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBgVGhlICR7dXNlckxvZ0luSW5wdXRUeXBlTmFtZX0gaW5wdXQgdHlwZSBpcyB1c2VkIHRvIGxvZ2luLmAsXG4gICAgICBmaWVsZHM6IHtcbiAgICAgICAgdXNlcm5hbWU6IHtcbiAgICAgICAgICBkZXNjcmlwdGlvbjogJ1RoaXMgaXMgdGhlIHVzZXJuYW1lIHVzZWQgdG8gbG9nIHRoZSB1c2VyIGluLicsXG4gICAgICAgICAgdHlwZTogbmV3IEdyYXBoUUxOb25OdWxsKEdyYXBoUUxTdHJpbmcpLFxuICAgICAgICB9LFxuICAgICAgICBwYXNzd29yZDoge1xuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnVGhpcyBpcyB0aGUgcGFzc3dvcmQgdXNlZCB0byBsb2cgdGhlIHVzZXIgaW4uJyxcbiAgICAgICAgICB0eXBlOiBuZXcgR3JhcGhRTE5vbk51bGwoR3JhcGhRTFN0cmluZyksXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgIH0pO1xuICAgIHBhcnNlR3JhcGhRTFNjaGVtYS5hZGRHcmFwaFFMVHlwZSh1c2VyTG9nSW5JbnB1dFR5cGUsIHRydWUsIHRydWUpO1xuXG4gICAgcGFyc2VHcmFwaFFMU2NoZW1hLnBhcnNlQ2xhc3NUeXBlc1tcbiAgICAgIGNsYXNzTmFtZVxuICAgIF0uc2lnblVwSW5wdXRUeXBlID0gdXNlclNpZ25VcElucHV0VHlwZTtcbiAgICBwYXJzZUdyYXBoUUxTY2hlbWEucGFyc2VDbGFzc1R5cGVzW1xuICAgICAgY2xhc3NOYW1lXG4gICAgXS5sb2dJbklucHV0VHlwZSA9IHVzZXJMb2dJbklucHV0VHlwZTtcbiAgfVxufTtcblxuZXhwb3J0IHsgZXh0cmFjdEtleXNBbmRJbmNsdWRlLCBsb2FkIH07XG4iXX0=