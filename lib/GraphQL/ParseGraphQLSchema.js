"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RESERVED_GRAPHQL_TYPE_NAMES = exports.ParseGraphQLSchema = void 0;
var _node = _interopRequireDefault(require("parse/node"));
var _graphql = require("graphql");
var _schema = require("@graphql-tools/schema");
var _merge = require("@graphql-tools/merge");
var _util = require("util");
var _requiredParameter = _interopRequireDefault(require("../requiredParameter"));
var defaultGraphQLTypes = _interopRequireWildcard(require("./loaders/defaultGraphQLTypes"));
var parseClassTypes = _interopRequireWildcard(require("./loaders/parseClassTypes"));
var parseClassQueries = _interopRequireWildcard(require("./loaders/parseClassQueries"));
var parseClassMutations = _interopRequireWildcard(require("./loaders/parseClassMutations"));
var defaultGraphQLQueries = _interopRequireWildcard(require("./loaders/defaultGraphQLQueries"));
var defaultGraphQLMutations = _interopRequireWildcard(require("./loaders/defaultGraphQLMutations"));
var _ParseGraphQLController = _interopRequireWildcard(require("../Controllers/ParseGraphQLController"));
var _DatabaseController = _interopRequireDefault(require("../Controllers/DatabaseController"));
var _SchemaCache = _interopRequireDefault(require("../Adapters/Cache/SchemaCache"));
var _parseGraphQLUtils = require("./parseGraphQLUtils");
var schemaDirectives = _interopRequireWildcard(require("./loaders/schemaDirectives"));
var schemaTypes = _interopRequireWildcard(require("./loaders/schemaTypes"));
var _triggers = require("../triggers");
var defaultRelaySchema = _interopRequireWildcard(require("./loaders/defaultRelaySchema"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const RESERVED_GRAPHQL_TYPE_NAMES = exports.RESERVED_GRAPHQL_TYPE_NAMES = ['String', 'Boolean', 'Int', 'Float', 'ID', 'ArrayResult', 'Query', 'Mutation', 'Subscription', 'CreateFileInput', 'CreateFilePayload', 'Viewer', 'SignUpInput', 'SignUpPayload', 'LogInWithInput', 'LogInWithPayload', 'UserLoginWithInput', 'LogInInput', 'LogInPayload', 'LogOutInput', 'LogOutPayload', 'ResetPasswordInput', 'ResetPasswordPayload', 'ConfirmResetPasswordInput', 'ConfirmResetPasswordPayload', 'SendVerificationEmailInput', 'SendVerificationEmailPayload', 'ChallengeInput', 'ChallengePayload', 'CloudCodeFunction', 'CallCloudCodeInput', 'CallCloudCodePayload', 'CreateClassInput', 'CreateClassPayload', 'UpdateClassInput', 'UpdateClassPayload', 'DeleteClassInput', 'DeleteClassPayload', 'SchemaField', 'ConfigValue', 'UpdateCloudConfigInput', 'UpdateCloudConfigPayload', 'PageInfo'];
const RESERVED_GRAPHQL_QUERY_NAMES = ['health', 'viewer', 'class', 'classes', 'cloudConfig'];
const RESERVED_GRAPHQL_MUTATION_NAMES = ['signUp', 'logInWith', 'logIn', 'logOut', 'resetPassword', 'confirmResetPassword', 'sendVerificationEmail', 'challenge', 'createFile', 'callCloudCode', 'createClass', 'updateClass', 'deleteClass', 'updateCloudConfig'];
class ParseGraphQLSchema {
  constructor(params = {}) {
    this.parseGraphQLController = params.parseGraphQLController || (0, _requiredParameter.default)('You must provide a parseGraphQLController instance!');
    this.databaseController = params.databaseController || (0, _requiredParameter.default)('You must provide a databaseController instance!');
    this.log = params.log || (0, _requiredParameter.default)('You must provide a log instance!');
    this.graphQLCustomTypeDefs = params.graphQLCustomTypeDefs;
    this.appId = params.appId || (0, _requiredParameter.default)('You must provide the appId!');
    this.schemaCache = _SchemaCache.default;
    this.logCache = {};
  }
  async load() {
    const {
      parseGraphQLConfig
    } = await this._initializeSchemaAndConfig();
    const parseClassesArray = await this._getClassesForSchema(parseGraphQLConfig);
    const functionNames = await this._getFunctionNames();
    const functionNamesString = functionNames.join();
    const parseClasses = parseClassesArray.reduce((acc, clazz) => {
      acc[clazz.className] = clazz;
      return acc;
    }, {});
    if (!this._hasSchemaInputChanged({
      parseClasses,
      parseGraphQLConfig,
      functionNamesString
    })) {
      return this.graphQLSchema;
    }
    this.parseClasses = parseClasses;
    this.parseGraphQLConfig = parseGraphQLConfig;
    this.functionNames = functionNames;
    this.functionNamesString = functionNamesString;
    this.parseClassTypes = {};
    this.viewerType = null;
    this.cloudConfigType = null;
    this.graphQLAutoSchema = null;
    this.graphQLSchema = null;
    this.graphQLTypes = [];
    this.graphQLQueries = {};
    this.graphQLMutations = {};
    this.graphQLSubscriptions = {};
    this.graphQLSchemaDirectivesDefinitions = null;
    this.graphQLSchemaDirectives = {};
    this.relayNodeInterface = null;
    defaultGraphQLTypes.load(this);
    defaultRelaySchema.load(this);
    schemaTypes.load(this);
    this._getParseClassesWithConfig(parseClassesArray, parseGraphQLConfig).forEach(([parseClass, parseClassConfig]) => {
      // Some times schema return the _auth_data_ field
      // it will lead to unstable graphql generation order
      if (parseClass.className === '_User') {
        Object.keys(parseClass.fields).forEach(fieldName => {
          if (fieldName.startsWith('_auth_data_')) {
            delete parseClass.fields[fieldName];
          }
        });
      }

      // Fields order inside the schema seems to not be consistent across
      // restart so we need to ensure an alphabetical order
      // also it's better for the playground documentation
      const orderedFields = {};
      Object.keys(parseClass.fields).sort().forEach(fieldName => {
        orderedFields[fieldName] = parseClass.fields[fieldName];
      });
      parseClass.fields = orderedFields;
      parseClassTypes.load(this, parseClass, parseClassConfig);
      parseClassQueries.load(this, parseClass, parseClassConfig);
      parseClassMutations.load(this, parseClass, parseClassConfig);
    });
    defaultGraphQLTypes.loadArrayResult(this, parseClassesArray);
    defaultGraphQLQueries.load(this);
    defaultGraphQLMutations.load(this);
    let graphQLQuery = undefined;
    if (Object.keys(this.graphQLQueries).length > 0) {
      graphQLQuery = new _graphql.GraphQLObjectType({
        name: 'Query',
        description: 'Query is the top level type for queries.',
        fields: this.graphQLQueries
      });
      this.addGraphQLType(graphQLQuery, true, true);
    }
    let graphQLMutation = undefined;
    if (Object.keys(this.graphQLMutations).length > 0) {
      graphQLMutation = new _graphql.GraphQLObjectType({
        name: 'Mutation',
        description: 'Mutation is the top level type for mutations.',
        fields: this.graphQLMutations
      });
      this.addGraphQLType(graphQLMutation, true, true);
    }
    let graphQLSubscription = undefined;
    if (Object.keys(this.graphQLSubscriptions).length > 0) {
      graphQLSubscription = new _graphql.GraphQLObjectType({
        name: 'Subscription',
        description: 'Subscription is the top level type for subscriptions.',
        fields: this.graphQLSubscriptions
      });
      this.addGraphQLType(graphQLSubscription, true, true);
    }
    this.graphQLAutoSchema = new _graphql.GraphQLSchema({
      types: this.graphQLTypes,
      query: graphQLQuery,
      mutation: graphQLMutation,
      subscription: graphQLSubscription
    });
    if (this.graphQLCustomTypeDefs) {
      schemaDirectives.load(this);
      if (typeof this.graphQLCustomTypeDefs.getTypeMap === 'function') {
        // In following code we use underscore attr to keep the direct variable reference
        const customGraphQLSchemaTypeMap = this.graphQLCustomTypeDefs._typeMap;
        const findAndReplaceLastType = (parent, key) => {
          if (parent[key].name) {
            if (this.graphQLAutoSchema._typeMap[parent[key].name] && this.graphQLAutoSchema._typeMap[parent[key].name] !== parent[key]) {
              // To avoid unresolved field on overloaded schema
              // replace the final type with the auto schema one
              parent[key] = this.graphQLAutoSchema._typeMap[parent[key].name];
            }
          } else {
            if (parent[key].ofType) {
              findAndReplaceLastType(parent[key], 'ofType');
            }
          }
        };
        // Add non shared types from custom schema to auto schema
        // note: some non shared types can use some shared types
        // so this code need to be ran before the shared types addition
        // we use sort to ensure schema consistency over restarts
        Object.keys(customGraphQLSchemaTypeMap).sort().forEach(customGraphQLSchemaTypeKey => {
          const customGraphQLSchemaType = customGraphQLSchemaTypeMap[customGraphQLSchemaTypeKey];
          if (!customGraphQLSchemaType || !customGraphQLSchemaType.name || customGraphQLSchemaType.name.startsWith('__')) {
            return;
          }
          const autoGraphQLSchemaType = this.graphQLAutoSchema._typeMap[customGraphQLSchemaType.name];
          if (!autoGraphQLSchemaType) {
            this.graphQLAutoSchema._typeMap[customGraphQLSchemaType.name] = customGraphQLSchemaType;
          }
        });
        // Handle shared types
        // We pass through each type and ensure that all sub field types are replaced
        // we use sort to ensure schema consistency over restarts
        Object.keys(customGraphQLSchemaTypeMap).sort().forEach(customGraphQLSchemaTypeKey => {
          const customGraphQLSchemaType = customGraphQLSchemaTypeMap[customGraphQLSchemaTypeKey];
          if (!customGraphQLSchemaType || !customGraphQLSchemaType.name || customGraphQLSchemaType.name.startsWith('__')) {
            return;
          }
          const autoGraphQLSchemaType = this.graphQLAutoSchema._typeMap[customGraphQLSchemaType.name];
          if (autoGraphQLSchemaType && typeof customGraphQLSchemaType.getFields === 'function') {
            Object.keys(customGraphQLSchemaType._fields).sort().forEach(fieldKey => {
              const field = customGraphQLSchemaType._fields[fieldKey];
              findAndReplaceLastType(field, 'type');
              autoGraphQLSchemaType._fields[field.name] = field;
            });
          }
        });
        this.graphQLSchema = this.graphQLAutoSchema;
      } else if (typeof this.graphQLCustomTypeDefs === 'function') {
        this.graphQLSchema = await this.graphQLCustomTypeDefs({
          directivesDefinitionsSchema: this.graphQLSchemaDirectivesDefinitions,
          autoSchema: this.graphQLAutoSchema,
          graphQLSchemaDirectives: this.graphQLSchemaDirectives
        });
      } else {
        this.graphQLSchema = (0, _schema.mergeSchemas)({
          schemas: [this.graphQLAutoSchema],
          typeDefs: (0, _merge.mergeTypeDefs)([this.graphQLCustomTypeDefs, this.graphQLSchemaDirectivesDefinitions])
        });
        this.graphQLSchema = this.graphQLSchemaDirectives(this.graphQLSchema);
      }
    } else {
      this.graphQLSchema = this.graphQLAutoSchema;
    }
    return this.graphQLSchema;
  }
  _logOnce(severity, message) {
    if (this.logCache[message]) {
      return;
    }
    this.log[severity](message);
    this.logCache[message] = true;
  }
  addGraphQLType(type, throwError = false, ignoreReserved = false, ignoreConnection = false) {
    if (!ignoreReserved && RESERVED_GRAPHQL_TYPE_NAMES.includes(type.name) || this.graphQLTypes.find(existingType => existingType.name === type.name) || !ignoreConnection && type.name.endsWith('Connection')) {
      const message = `Type ${type.name} could not be added to the auto schema because it collided with an existing type.`;
      if (throwError) {
        throw new Error(message);
      }
      this._logOnce('warn', message);
      return undefined;
    }
    this.graphQLTypes.push(type);
    return type;
  }
  addGraphQLQuery(fieldName, field, throwError = false, ignoreReserved = false) {
    if (!ignoreReserved && RESERVED_GRAPHQL_QUERY_NAMES.includes(fieldName) || this.graphQLQueries[fieldName]) {
      const message = `Query ${fieldName} could not be added to the auto schema because it collided with an existing field.`;
      if (throwError) {
        throw new Error(message);
      }
      this._logOnce('warn', message);
      return undefined;
    }
    this.graphQLQueries[fieldName] = field;
    return field;
  }
  addGraphQLMutation(fieldName, field, throwError = false, ignoreReserved = false) {
    if (!ignoreReserved && RESERVED_GRAPHQL_MUTATION_NAMES.includes(fieldName) || this.graphQLMutations[fieldName]) {
      const message = `Mutation ${fieldName} could not be added to the auto schema because it collided with an existing field.`;
      if (throwError) {
        throw new Error(message);
      }
      this._logOnce('warn', message);
      return undefined;
    }
    this.graphQLMutations[fieldName] = field;
    return field;
  }
  handleError(error) {
    if (error instanceof _node.default.Error) {
      this.log.error('Parse error: ', error);
    } else {
      this.log.error('Uncaught internal server error.', error, error.stack);
    }
    throw (0, _parseGraphQLUtils.toGraphQLError)(error);
  }
  async _initializeSchemaAndConfig() {
    const [schemaController, parseGraphQLConfig] = await Promise.all([this.databaseController.loadSchema(), this.parseGraphQLController.getGraphQLConfig()]);
    this.schemaController = schemaController;
    return {
      parseGraphQLConfig
    };
  }

  /**
   * Gets all classes found by the `schemaController`
   * minus those filtered out by the app's parseGraphQLConfig.
   */
  async _getClassesForSchema(parseGraphQLConfig) {
    const {
      enabledForClasses,
      disabledForClasses
    } = parseGraphQLConfig;
    const allClasses = await this.schemaController.getAllClasses();
    if (Array.isArray(enabledForClasses) || Array.isArray(disabledForClasses)) {
      let includedClasses = allClasses;
      if (enabledForClasses) {
        includedClasses = allClasses.filter(clazz => {
          return enabledForClasses.includes(clazz.className);
        });
      }
      if (disabledForClasses) {
        // Classes included in `enabledForClasses` that
        // are also present in `disabledForClasses` will
        // still be filtered out
        includedClasses = includedClasses.filter(clazz => {
          return !disabledForClasses.includes(clazz.className);
        });
      }
      this.isUsersClassDisabled = !includedClasses.some(clazz => {
        return clazz.className === '_User';
      });
      return includedClasses;
    } else {
      return allClasses;
    }
  }

  /**
   * This method returns a list of tuples
   * that provide the parseClass along with
   * its parseClassConfig where provided.
   */
  _getParseClassesWithConfig(parseClasses, parseGraphQLConfig) {
    const {
      classConfigs
    } = parseGraphQLConfig;

    // Make sures that the default classes and classes that
    // starts with capitalized letter will be generated first.
    const sortClasses = (a, b) => {
      a = a.className;
      b = b.className;
      if (a[0] === '_') {
        if (b[0] !== '_') {
          return -1;
        }
      }
      if (b[0] === '_') {
        if (a[0] !== '_') {
          return 1;
        }
      }
      if (a === b) {
        return 0;
      } else if (a < b) {
        return -1;
      } else {
        return 1;
      }
    };
    return parseClasses.sort(sortClasses).map(parseClass => {
      let parseClassConfig;
      if (classConfigs) {
        parseClassConfig = classConfigs.find(c => c.className === parseClass.className);
      }
      return [parseClass, parseClassConfig];
    });
  }
  async _getFunctionNames() {
    return await (0, _triggers.getFunctionNames)(this.appId).filter(functionName => {
      if (/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(functionName)) {
        return true;
      } else {
        this._logOnce('warn', `Function ${functionName} could not be added to the auto schema because GraphQL names must match /^[_a-zA-Z][_a-zA-Z0-9]*$/.`);
        return false;
      }
    });
  }

  /**
   * Checks for changes to the parseClasses
   * objects (i.e. database schema) or to
   * the parseGraphQLConfig object. If no
   * changes are found, return true;
   */
  _hasSchemaInputChanged(params) {
    const {
      parseClasses,
      parseGraphQLConfig,
      functionNamesString
    } = params;

    // First init
    if (!this.graphQLSchema) {
      return true;
    }
    if ((0, _util.isDeepStrictEqual)(this.parseGraphQLConfig, parseGraphQLConfig) && this.functionNamesString === functionNamesString && (0, _util.isDeepStrictEqual)(this.parseClasses, parseClasses)) {
      return false;
    }
    return true;
  }
}
exports.ParseGraphQLSchema = ParseGraphQLSchema;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfbm9kZSIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX2dyYXBocWwiLCJfc2NoZW1hIiwiX21lcmdlIiwiX3V0aWwiLCJfcmVxdWlyZWRQYXJhbWV0ZXIiLCJkZWZhdWx0R3JhcGhRTFR5cGVzIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJwYXJzZUNsYXNzVHlwZXMiLCJwYXJzZUNsYXNzUXVlcmllcyIsInBhcnNlQ2xhc3NNdXRhdGlvbnMiLCJkZWZhdWx0R3JhcGhRTFF1ZXJpZXMiLCJkZWZhdWx0R3JhcGhRTE11dGF0aW9ucyIsIl9QYXJzZUdyYXBoUUxDb250cm9sbGVyIiwiX0RhdGFiYXNlQ29udHJvbGxlciIsIl9TY2hlbWFDYWNoZSIsIl9wYXJzZUdyYXBoUUxVdGlscyIsInNjaGVtYURpcmVjdGl2ZXMiLCJzY2hlbWFUeXBlcyIsIl90cmlnZ2VycyIsImRlZmF1bHRSZWxheVNjaGVtYSIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsIlJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUyIsImV4cG9ydHMiLCJSRVNFUlZFRF9HUkFQSFFMX1FVRVJZX05BTUVTIiwiUkVTRVJWRURfR1JBUEhRTF9NVVRBVElPTl9OQU1FUyIsIlBhcnNlR3JhcGhRTFNjaGVtYSIsImNvbnN0cnVjdG9yIiwicGFyYW1zIiwicGFyc2VHcmFwaFFMQ29udHJvbGxlciIsInJlcXVpcmVkUGFyYW1ldGVyIiwiZGF0YWJhc2VDb250cm9sbGVyIiwibG9nIiwiZ3JhcGhRTEN1c3RvbVR5cGVEZWZzIiwiYXBwSWQiLCJzY2hlbWFDYWNoZSIsIlNjaGVtYUNhY2hlIiwibG9nQ2FjaGUiLCJsb2FkIiwicGFyc2VHcmFwaFFMQ29uZmlnIiwiX2luaXRpYWxpemVTY2hlbWFBbmRDb25maWciLCJwYXJzZUNsYXNzZXNBcnJheSIsIl9nZXRDbGFzc2VzRm9yU2NoZW1hIiwiZnVuY3Rpb25OYW1lcyIsIl9nZXRGdW5jdGlvbk5hbWVzIiwiZnVuY3Rpb25OYW1lc1N0cmluZyIsImpvaW4iLCJwYXJzZUNsYXNzZXMiLCJyZWR1Y2UiLCJhY2MiLCJjbGF6eiIsImNsYXNzTmFtZSIsIl9oYXNTY2hlbWFJbnB1dENoYW5nZWQiLCJncmFwaFFMU2NoZW1hIiwidmlld2VyVHlwZSIsImNsb3VkQ29uZmlnVHlwZSIsImdyYXBoUUxBdXRvU2NoZW1hIiwiZ3JhcGhRTFR5cGVzIiwiZ3JhcGhRTFF1ZXJpZXMiLCJncmFwaFFMTXV0YXRpb25zIiwiZ3JhcGhRTFN1YnNjcmlwdGlvbnMiLCJncmFwaFFMU2NoZW1hRGlyZWN0aXZlc0RlZmluaXRpb25zIiwiZ3JhcGhRTFNjaGVtYURpcmVjdGl2ZXMiLCJyZWxheU5vZGVJbnRlcmZhY2UiLCJfZ2V0UGFyc2VDbGFzc2VzV2l0aENvbmZpZyIsImZvckVhY2giLCJwYXJzZUNsYXNzIiwicGFyc2VDbGFzc0NvbmZpZyIsImtleXMiLCJmaWVsZHMiLCJmaWVsZE5hbWUiLCJzdGFydHNXaXRoIiwib3JkZXJlZEZpZWxkcyIsInNvcnQiLCJsb2FkQXJyYXlSZXN1bHQiLCJncmFwaFFMUXVlcnkiLCJ1bmRlZmluZWQiLCJsZW5ndGgiLCJHcmFwaFFMT2JqZWN0VHlwZSIsIm5hbWUiLCJkZXNjcmlwdGlvbiIsImFkZEdyYXBoUUxUeXBlIiwiZ3JhcGhRTE11dGF0aW9uIiwiZ3JhcGhRTFN1YnNjcmlwdGlvbiIsIkdyYXBoUUxTY2hlbWEiLCJ0eXBlcyIsInF1ZXJ5IiwibXV0YXRpb24iLCJzdWJzY3JpcHRpb24iLCJnZXRUeXBlTWFwIiwiY3VzdG9tR3JhcGhRTFNjaGVtYVR5cGVNYXAiLCJfdHlwZU1hcCIsImZpbmRBbmRSZXBsYWNlTGFzdFR5cGUiLCJwYXJlbnQiLCJrZXkiLCJvZlR5cGUiLCJjdXN0b21HcmFwaFFMU2NoZW1hVHlwZUtleSIsImN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlIiwiYXV0b0dyYXBoUUxTY2hlbWFUeXBlIiwiZ2V0RmllbGRzIiwiX2ZpZWxkcyIsImZpZWxkS2V5IiwiZmllbGQiLCJkaXJlY3RpdmVzRGVmaW5pdGlvbnNTY2hlbWEiLCJhdXRvU2NoZW1hIiwibWVyZ2VTY2hlbWFzIiwic2NoZW1hcyIsInR5cGVEZWZzIiwibWVyZ2VUeXBlRGVmcyIsIl9sb2dPbmNlIiwic2V2ZXJpdHkiLCJtZXNzYWdlIiwidHlwZSIsInRocm93RXJyb3IiLCJpZ25vcmVSZXNlcnZlZCIsImlnbm9yZUNvbm5lY3Rpb24iLCJpbmNsdWRlcyIsImZpbmQiLCJleGlzdGluZ1R5cGUiLCJlbmRzV2l0aCIsIkVycm9yIiwicHVzaCIsImFkZEdyYXBoUUxRdWVyeSIsImFkZEdyYXBoUUxNdXRhdGlvbiIsImhhbmRsZUVycm9yIiwiZXJyb3IiLCJQYXJzZSIsInN0YWNrIiwidG9HcmFwaFFMRXJyb3IiLCJzY2hlbWFDb250cm9sbGVyIiwiUHJvbWlzZSIsImFsbCIsImxvYWRTY2hlbWEiLCJnZXRHcmFwaFFMQ29uZmlnIiwiZW5hYmxlZEZvckNsYXNzZXMiLCJkaXNhYmxlZEZvckNsYXNzZXMiLCJhbGxDbGFzc2VzIiwiZ2V0QWxsQ2xhc3NlcyIsIkFycmF5IiwiaXNBcnJheSIsImluY2x1ZGVkQ2xhc3NlcyIsImZpbHRlciIsImlzVXNlcnNDbGFzc0Rpc2FibGVkIiwic29tZSIsImNsYXNzQ29uZmlncyIsInNvcnRDbGFzc2VzIiwiYSIsImIiLCJtYXAiLCJjIiwiZ2V0RnVuY3Rpb25OYW1lcyIsImZ1bmN0aW9uTmFtZSIsInRlc3QiLCJpc0RlZXBTdHJpY3RFcXVhbCJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9HcmFwaFFML1BhcnNlR3JhcGhRTFNjaGVtYS5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBHcmFwaFFMU2NoZW1hLCBHcmFwaFFMT2JqZWN0VHlwZSwgRG9jdW1lbnROb2RlLCBHcmFwaFFMTmFtZWRUeXBlIH0gZnJvbSAnZ3JhcGhxbCc7XG5pbXBvcnQgeyBtZXJnZVNjaGVtYXMgfSBmcm9tICdAZ3JhcGhxbC10b29scy9zY2hlbWEnO1xuaW1wb3J0IHsgbWVyZ2VUeXBlRGVmcyB9IGZyb20gJ0BncmFwaHFsLXRvb2xzL21lcmdlJztcbmltcG9ydCB7IGlzRGVlcFN0cmljdEVxdWFsIH0gZnJvbSAndXRpbCc7XG5pbXBvcnQgcmVxdWlyZWRQYXJhbWV0ZXIgZnJvbSAnLi4vcmVxdWlyZWRQYXJhbWV0ZXInO1xuaW1wb3J0ICogYXMgZGVmYXVsdEdyYXBoUUxUeXBlcyBmcm9tICcuL2xvYWRlcnMvZGVmYXVsdEdyYXBoUUxUeXBlcyc7XG5pbXBvcnQgKiBhcyBwYXJzZUNsYXNzVHlwZXMgZnJvbSAnLi9sb2FkZXJzL3BhcnNlQ2xhc3NUeXBlcyc7XG5pbXBvcnQgKiBhcyBwYXJzZUNsYXNzUXVlcmllcyBmcm9tICcuL2xvYWRlcnMvcGFyc2VDbGFzc1F1ZXJpZXMnO1xuaW1wb3J0ICogYXMgcGFyc2VDbGFzc011dGF0aW9ucyBmcm9tICcuL2xvYWRlcnMvcGFyc2VDbGFzc011dGF0aW9ucyc7XG5pbXBvcnQgKiBhcyBkZWZhdWx0R3JhcGhRTFF1ZXJpZXMgZnJvbSAnLi9sb2FkZXJzL2RlZmF1bHRHcmFwaFFMUXVlcmllcyc7XG5pbXBvcnQgKiBhcyBkZWZhdWx0R3JhcGhRTE11dGF0aW9ucyBmcm9tICcuL2xvYWRlcnMvZGVmYXVsdEdyYXBoUUxNdXRhdGlvbnMnO1xuaW1wb3J0IFBhcnNlR3JhcGhRTENvbnRyb2xsZXIsIHsgUGFyc2VHcmFwaFFMQ29uZmlnIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMvUGFyc2VHcmFwaFFMQ29udHJvbGxlcic7XG5pbXBvcnQgRGF0YWJhc2VDb250cm9sbGVyIGZyb20gJy4uL0NvbnRyb2xsZXJzL0RhdGFiYXNlQ29udHJvbGxlcic7XG5pbXBvcnQgU2NoZW1hQ2FjaGUgZnJvbSAnLi4vQWRhcHRlcnMvQ2FjaGUvU2NoZW1hQ2FjaGUnO1xuaW1wb3J0IHsgdG9HcmFwaFFMRXJyb3IgfSBmcm9tICcuL3BhcnNlR3JhcGhRTFV0aWxzJztcbmltcG9ydCAqIGFzIHNjaGVtYURpcmVjdGl2ZXMgZnJvbSAnLi9sb2FkZXJzL3NjaGVtYURpcmVjdGl2ZXMnO1xuaW1wb3J0ICogYXMgc2NoZW1hVHlwZXMgZnJvbSAnLi9sb2FkZXJzL3NjaGVtYVR5cGVzJztcbmltcG9ydCB7IGdldEZ1bmN0aW9uTmFtZXMgfSBmcm9tICcuLi90cmlnZ2Vycyc7XG5pbXBvcnQgKiBhcyBkZWZhdWx0UmVsYXlTY2hlbWEgZnJvbSAnLi9sb2FkZXJzL2RlZmF1bHRSZWxheVNjaGVtYSc7XG5cbmNvbnN0IFJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUyA9IFtcbiAgJ1N0cmluZycsXG4gICdCb29sZWFuJyxcbiAgJ0ludCcsXG4gICdGbG9hdCcsXG4gICdJRCcsXG4gICdBcnJheVJlc3VsdCcsXG4gICdRdWVyeScsXG4gICdNdXRhdGlvbicsXG4gICdTdWJzY3JpcHRpb24nLFxuICAnQ3JlYXRlRmlsZUlucHV0JyxcbiAgJ0NyZWF0ZUZpbGVQYXlsb2FkJyxcbiAgJ1ZpZXdlcicsXG4gICdTaWduVXBJbnB1dCcsXG4gICdTaWduVXBQYXlsb2FkJyxcbiAgJ0xvZ0luV2l0aElucHV0JyxcbiAgJ0xvZ0luV2l0aFBheWxvYWQnLFxuICAnVXNlckxvZ2luV2l0aElucHV0JyxcbiAgJ0xvZ0luSW5wdXQnLFxuICAnTG9nSW5QYXlsb2FkJyxcbiAgJ0xvZ091dElucHV0JyxcbiAgJ0xvZ091dFBheWxvYWQnLFxuICAnUmVzZXRQYXNzd29yZElucHV0JyxcbiAgJ1Jlc2V0UGFzc3dvcmRQYXlsb2FkJyxcbiAgJ0NvbmZpcm1SZXNldFBhc3N3b3JkSW5wdXQnLFxuICAnQ29uZmlybVJlc2V0UGFzc3dvcmRQYXlsb2FkJyxcbiAgJ1NlbmRWZXJpZmljYXRpb25FbWFpbElucHV0JyxcbiAgJ1NlbmRWZXJpZmljYXRpb25FbWFpbFBheWxvYWQnLFxuICAnQ2hhbGxlbmdlSW5wdXQnLFxuICAnQ2hhbGxlbmdlUGF5bG9hZCcsXG4gICdDbG91ZENvZGVGdW5jdGlvbicsXG4gICdDYWxsQ2xvdWRDb2RlSW5wdXQnLFxuICAnQ2FsbENsb3VkQ29kZVBheWxvYWQnLFxuICAnQ3JlYXRlQ2xhc3NJbnB1dCcsXG4gICdDcmVhdGVDbGFzc1BheWxvYWQnLFxuICAnVXBkYXRlQ2xhc3NJbnB1dCcsXG4gICdVcGRhdGVDbGFzc1BheWxvYWQnLFxuICAnRGVsZXRlQ2xhc3NJbnB1dCcsXG4gICdEZWxldGVDbGFzc1BheWxvYWQnLFxuICAnU2NoZW1hRmllbGQnLFxuICAnQ29uZmlnVmFsdWUnLFxuICAnVXBkYXRlQ2xvdWRDb25maWdJbnB1dCcsXG4gICdVcGRhdGVDbG91ZENvbmZpZ1BheWxvYWQnLFxuICAnUGFnZUluZm8nLFxuXTtcbmNvbnN0IFJFU0VSVkVEX0dSQVBIUUxfUVVFUllfTkFNRVMgPSBbJ2hlYWx0aCcsICd2aWV3ZXInLCAnY2xhc3MnLCAnY2xhc3NlcycsICdjbG91ZENvbmZpZyddO1xuY29uc3QgUkVTRVJWRURfR1JBUEhRTF9NVVRBVElPTl9OQU1FUyA9IFtcbiAgJ3NpZ25VcCcsXG4gICdsb2dJbldpdGgnLFxuICAnbG9nSW4nLFxuICAnbG9nT3V0JyxcbiAgJ3Jlc2V0UGFzc3dvcmQnLFxuICAnY29uZmlybVJlc2V0UGFzc3dvcmQnLFxuICAnc2VuZFZlcmlmaWNhdGlvbkVtYWlsJyxcbiAgJ2NoYWxsZW5nZScsXG4gICdjcmVhdGVGaWxlJyxcbiAgJ2NhbGxDbG91ZENvZGUnLFxuICAnY3JlYXRlQ2xhc3MnLFxuICAndXBkYXRlQ2xhc3MnLFxuICAnZGVsZXRlQ2xhc3MnLFxuICAndXBkYXRlQ2xvdWRDb25maWcnLFxuXTtcblxuY2xhc3MgUGFyc2VHcmFwaFFMU2NoZW1hIHtcbiAgZGF0YWJhc2VDb250cm9sbGVyOiBEYXRhYmFzZUNvbnRyb2xsZXI7XG4gIHBhcnNlR3JhcGhRTENvbnRyb2xsZXI6IFBhcnNlR3JhcGhRTENvbnRyb2xsZXI7XG4gIHBhcnNlR3JhcGhRTENvbmZpZzogUGFyc2VHcmFwaFFMQ29uZmlnO1xuICBsb2c6IGFueTtcbiAgYXBwSWQ6IHN0cmluZztcbiAgZ3JhcGhRTEN1c3RvbVR5cGVEZWZzOiA/KHN0cmluZyB8IEdyYXBoUUxTY2hlbWEgfCBEb2N1bWVudE5vZGUgfCBHcmFwaFFMTmFtZWRUeXBlW10pO1xuICBzY2hlbWFDYWNoZTogYW55O1xuXG4gIGNvbnN0cnVjdG9yKFxuICAgIHBhcmFtczoge1xuICAgICAgZGF0YWJhc2VDb250cm9sbGVyOiBEYXRhYmFzZUNvbnRyb2xsZXIsXG4gICAgICBwYXJzZUdyYXBoUUxDb250cm9sbGVyOiBQYXJzZUdyYXBoUUxDb250cm9sbGVyLFxuICAgICAgbG9nOiBhbnksXG4gICAgICBhcHBJZDogc3RyaW5nLFxuICAgICAgZ3JhcGhRTEN1c3RvbVR5cGVEZWZzOiA/KHN0cmluZyB8IEdyYXBoUUxTY2hlbWEgfCBEb2N1bWVudE5vZGUgfCBHcmFwaFFMTmFtZWRUeXBlW10pLFxuICAgIH0gPSB7fVxuICApIHtcbiAgICB0aGlzLnBhcnNlR3JhcGhRTENvbnRyb2xsZXIgPVxuICAgICAgcGFyYW1zLnBhcnNlR3JhcGhRTENvbnRyb2xsZXIgfHxcbiAgICAgIHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgcGFyc2VHcmFwaFFMQ29udHJvbGxlciBpbnN0YW5jZSEnKTtcbiAgICB0aGlzLmRhdGFiYXNlQ29udHJvbGxlciA9XG4gICAgICBwYXJhbXMuZGF0YWJhc2VDb250cm9sbGVyIHx8XG4gICAgICByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIGRhdGFiYXNlQ29udHJvbGxlciBpbnN0YW5jZSEnKTtcbiAgICB0aGlzLmxvZyA9IHBhcmFtcy5sb2cgfHwgcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYSBsb2cgaW5zdGFuY2UhJyk7XG4gICAgdGhpcy5ncmFwaFFMQ3VzdG9tVHlwZURlZnMgPSBwYXJhbXMuZ3JhcGhRTEN1c3RvbVR5cGVEZWZzO1xuICAgIHRoaXMuYXBwSWQgPSBwYXJhbXMuYXBwSWQgfHwgcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgdGhlIGFwcElkIScpO1xuICAgIHRoaXMuc2NoZW1hQ2FjaGUgPSBTY2hlbWFDYWNoZTtcbiAgICB0aGlzLmxvZ0NhY2hlID0ge307XG4gIH1cblxuICBhc3luYyBsb2FkKCkge1xuICAgIGNvbnN0IHsgcGFyc2VHcmFwaFFMQ29uZmlnIH0gPSBhd2FpdCB0aGlzLl9pbml0aWFsaXplU2NoZW1hQW5kQ29uZmlnKCk7XG4gICAgY29uc3QgcGFyc2VDbGFzc2VzQXJyYXkgPSBhd2FpdCB0aGlzLl9nZXRDbGFzc2VzRm9yU2NoZW1hKHBhcnNlR3JhcGhRTENvbmZpZyk7XG4gICAgY29uc3QgZnVuY3Rpb25OYW1lcyA9IGF3YWl0IHRoaXMuX2dldEZ1bmN0aW9uTmFtZXMoKTtcbiAgICBjb25zdCBmdW5jdGlvbk5hbWVzU3RyaW5nID0gZnVuY3Rpb25OYW1lcy5qb2luKCk7XG5cbiAgICBjb25zdCBwYXJzZUNsYXNzZXMgPSBwYXJzZUNsYXNzZXNBcnJheS5yZWR1Y2UoKGFjYywgY2xhenopID0+IHtcbiAgICAgIGFjY1tjbGF6ei5jbGFzc05hbWVdID0gY2xheno7XG4gICAgICByZXR1cm4gYWNjO1xuICAgIH0sIHt9KTtcbiAgICBpZiAoXG4gICAgICAhdGhpcy5faGFzU2NoZW1hSW5wdXRDaGFuZ2VkKHtcbiAgICAgICAgcGFyc2VDbGFzc2VzLFxuICAgICAgICBwYXJzZUdyYXBoUUxDb25maWcsXG4gICAgICAgIGZ1bmN0aW9uTmFtZXNTdHJpbmcsXG4gICAgICB9KVxuICAgICkge1xuICAgICAgcmV0dXJuIHRoaXMuZ3JhcGhRTFNjaGVtYTtcbiAgICB9XG5cbiAgICB0aGlzLnBhcnNlQ2xhc3NlcyA9IHBhcnNlQ2xhc3NlcztcbiAgICB0aGlzLnBhcnNlR3JhcGhRTENvbmZpZyA9IHBhcnNlR3JhcGhRTENvbmZpZztcbiAgICB0aGlzLmZ1bmN0aW9uTmFtZXMgPSBmdW5jdGlvbk5hbWVzO1xuICAgIHRoaXMuZnVuY3Rpb25OYW1lc1N0cmluZyA9IGZ1bmN0aW9uTmFtZXNTdHJpbmc7XG4gICAgdGhpcy5wYXJzZUNsYXNzVHlwZXMgPSB7fTtcbiAgICB0aGlzLnZpZXdlclR5cGUgPSBudWxsO1xuICAgIHRoaXMuY2xvdWRDb25maWdUeXBlID0gbnVsbDtcbiAgICB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hID0gbnVsbDtcbiAgICB0aGlzLmdyYXBoUUxTY2hlbWEgPSBudWxsO1xuICAgIHRoaXMuZ3JhcGhRTFR5cGVzID0gW107XG4gICAgdGhpcy5ncmFwaFFMUXVlcmllcyA9IHt9O1xuICAgIHRoaXMuZ3JhcGhRTE11dGF0aW9ucyA9IHt9O1xuICAgIHRoaXMuZ3JhcGhRTFN1YnNjcmlwdGlvbnMgPSB7fTtcbiAgICB0aGlzLmdyYXBoUUxTY2hlbWFEaXJlY3RpdmVzRGVmaW5pdGlvbnMgPSBudWxsO1xuICAgIHRoaXMuZ3JhcGhRTFNjaGVtYURpcmVjdGl2ZXMgPSB7fTtcbiAgICB0aGlzLnJlbGF5Tm9kZUludGVyZmFjZSA9IG51bGw7XG5cbiAgICBkZWZhdWx0R3JhcGhRTFR5cGVzLmxvYWQodGhpcyk7XG4gICAgZGVmYXVsdFJlbGF5U2NoZW1hLmxvYWQodGhpcyk7XG4gICAgc2NoZW1hVHlwZXMubG9hZCh0aGlzKTtcblxuICAgIHRoaXMuX2dldFBhcnNlQ2xhc3Nlc1dpdGhDb25maWcocGFyc2VDbGFzc2VzQXJyYXksIHBhcnNlR3JhcGhRTENvbmZpZykuZm9yRWFjaChcbiAgICAgIChbcGFyc2VDbGFzcywgcGFyc2VDbGFzc0NvbmZpZ10pID0+IHtcbiAgICAgICAgLy8gU29tZSB0aW1lcyBzY2hlbWEgcmV0dXJuIHRoZSBfYXV0aF9kYXRhXyBmaWVsZFxuICAgICAgICAvLyBpdCB3aWxsIGxlYWQgdG8gdW5zdGFibGUgZ3JhcGhxbCBnZW5lcmF0aW9uIG9yZGVyXG4gICAgICAgIGlmIChwYXJzZUNsYXNzLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgICAgICAgIE9iamVjdC5rZXlzKHBhcnNlQ2xhc3MuZmllbGRzKS5mb3JFYWNoKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lLnN0YXJ0c1dpdGgoJ19hdXRoX2RhdGFfJykpIHtcbiAgICAgICAgICAgICAgZGVsZXRlIHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGaWVsZHMgb3JkZXIgaW5zaWRlIHRoZSBzY2hlbWEgc2VlbXMgdG8gbm90IGJlIGNvbnNpc3RlbnQgYWNyb3NzXG4gICAgICAgIC8vIHJlc3RhcnQgc28gd2UgbmVlZCB0byBlbnN1cmUgYW4gYWxwaGFiZXRpY2FsIG9yZGVyXG4gICAgICAgIC8vIGFsc28gaXQncyBiZXR0ZXIgZm9yIHRoZSBwbGF5Z3JvdW5kIGRvY3VtZW50YXRpb25cbiAgICAgICAgY29uc3Qgb3JkZXJlZEZpZWxkcyA9IHt9O1xuICAgICAgICBPYmplY3Qua2V5cyhwYXJzZUNsYXNzLmZpZWxkcylcbiAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIG9yZGVyZWRGaWVsZHNbZmllbGROYW1lXSA9IHBhcnNlQ2xhc3MuZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICAgICAgfSk7XG4gICAgICAgIHBhcnNlQ2xhc3MuZmllbGRzID0gb3JkZXJlZEZpZWxkcztcbiAgICAgICAgcGFyc2VDbGFzc1R5cGVzLmxvYWQodGhpcywgcGFyc2VDbGFzcywgcGFyc2VDbGFzc0NvbmZpZyk7XG4gICAgICAgIHBhcnNlQ2xhc3NRdWVyaWVzLmxvYWQodGhpcywgcGFyc2VDbGFzcywgcGFyc2VDbGFzc0NvbmZpZyk7XG4gICAgICAgIHBhcnNlQ2xhc3NNdXRhdGlvbnMubG9hZCh0aGlzLCBwYXJzZUNsYXNzLCBwYXJzZUNsYXNzQ29uZmlnKTtcbiAgICAgIH1cbiAgICApO1xuXG4gICAgZGVmYXVsdEdyYXBoUUxUeXBlcy5sb2FkQXJyYXlSZXN1bHQodGhpcywgcGFyc2VDbGFzc2VzQXJyYXkpO1xuICAgIGRlZmF1bHRHcmFwaFFMUXVlcmllcy5sb2FkKHRoaXMpO1xuICAgIGRlZmF1bHRHcmFwaFFMTXV0YXRpb25zLmxvYWQodGhpcyk7XG5cbiAgICBsZXQgZ3JhcGhRTFF1ZXJ5ID0gdW5kZWZpbmVkO1xuICAgIGlmIChPYmplY3Qua2V5cyh0aGlzLmdyYXBoUUxRdWVyaWVzKS5sZW5ndGggPiAwKSB7XG4gICAgICBncmFwaFFMUXVlcnkgPSBuZXcgR3JhcGhRTE9iamVjdFR5cGUoe1xuICAgICAgICBuYW1lOiAnUXVlcnknLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1F1ZXJ5IGlzIHRoZSB0b3AgbGV2ZWwgdHlwZSBmb3IgcXVlcmllcy4nLFxuICAgICAgICBmaWVsZHM6IHRoaXMuZ3JhcGhRTFF1ZXJpZXMsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYWRkR3JhcGhRTFR5cGUoZ3JhcGhRTFF1ZXJ5LCB0cnVlLCB0cnVlKTtcbiAgICB9XG5cbiAgICBsZXQgZ3JhcGhRTE11dGF0aW9uID0gdW5kZWZpbmVkO1xuICAgIGlmIChPYmplY3Qua2V5cyh0aGlzLmdyYXBoUUxNdXRhdGlvbnMpLmxlbmd0aCA+IDApIHtcbiAgICAgIGdyYXBoUUxNdXRhdGlvbiA9IG5ldyBHcmFwaFFMT2JqZWN0VHlwZSh7XG4gICAgICAgIG5hbWU6ICdNdXRhdGlvbicsXG4gICAgICAgIGRlc2NyaXB0aW9uOiAnTXV0YXRpb24gaXMgdGhlIHRvcCBsZXZlbCB0eXBlIGZvciBtdXRhdGlvbnMuJyxcbiAgICAgICAgZmllbGRzOiB0aGlzLmdyYXBoUUxNdXRhdGlvbnMsXG4gICAgICB9KTtcbiAgICAgIHRoaXMuYWRkR3JhcGhRTFR5cGUoZ3JhcGhRTE11dGF0aW9uLCB0cnVlLCB0cnVlKTtcbiAgICB9XG5cbiAgICBsZXQgZ3JhcGhRTFN1YnNjcmlwdGlvbiA9IHVuZGVmaW5lZDtcbiAgICBpZiAoT2JqZWN0LmtleXModGhpcy5ncmFwaFFMU3Vic2NyaXB0aW9ucykubGVuZ3RoID4gMCkge1xuICAgICAgZ3JhcGhRTFN1YnNjcmlwdGlvbiA9IG5ldyBHcmFwaFFMT2JqZWN0VHlwZSh7XG4gICAgICAgIG5hbWU6ICdTdWJzY3JpcHRpb24nLFxuICAgICAgICBkZXNjcmlwdGlvbjogJ1N1YnNjcmlwdGlvbiBpcyB0aGUgdG9wIGxldmVsIHR5cGUgZm9yIHN1YnNjcmlwdGlvbnMuJyxcbiAgICAgICAgZmllbGRzOiB0aGlzLmdyYXBoUUxTdWJzY3JpcHRpb25zLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmFkZEdyYXBoUUxUeXBlKGdyYXBoUUxTdWJzY3JpcHRpb24sIHRydWUsIHRydWUpO1xuICAgIH1cblxuICAgIHRoaXMuZ3JhcGhRTEF1dG9TY2hlbWEgPSBuZXcgR3JhcGhRTFNjaGVtYSh7XG4gICAgICB0eXBlczogdGhpcy5ncmFwaFFMVHlwZXMsXG4gICAgICBxdWVyeTogZ3JhcGhRTFF1ZXJ5LFxuICAgICAgbXV0YXRpb246IGdyYXBoUUxNdXRhdGlvbixcbiAgICAgIHN1YnNjcmlwdGlvbjogZ3JhcGhRTFN1YnNjcmlwdGlvbixcbiAgICB9KTtcblxuICAgIGlmICh0aGlzLmdyYXBoUUxDdXN0b21UeXBlRGVmcykge1xuICAgICAgc2NoZW1hRGlyZWN0aXZlcy5sb2FkKHRoaXMpO1xuICAgICAgaWYgKHR5cGVvZiB0aGlzLmdyYXBoUUxDdXN0b21UeXBlRGVmcy5nZXRUeXBlTWFwID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIC8vIEluIGZvbGxvd2luZyBjb2RlIHdlIHVzZSB1bmRlcnNjb3JlIGF0dHIgdG8ga2VlcCB0aGUgZGlyZWN0IHZhcmlhYmxlIHJlZmVyZW5jZVxuICAgICAgICBjb25zdCBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZU1hcCA9IHRoaXMuZ3JhcGhRTEN1c3RvbVR5cGVEZWZzLl90eXBlTWFwO1xuICAgICAgICBjb25zdCBmaW5kQW5kUmVwbGFjZUxhc3RUeXBlID0gKHBhcmVudCwga2V5KSA9PiB7XG4gICAgICAgICAgaWYgKHBhcmVudFtrZXldLm5hbWUpIHtcbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgdGhpcy5ncmFwaFFMQXV0b1NjaGVtYS5fdHlwZU1hcFtwYXJlbnRba2V5XS5uYW1lXSAmJlxuICAgICAgICAgICAgICB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hLl90eXBlTWFwW3BhcmVudFtrZXldLm5hbWVdICE9PSBwYXJlbnRba2V5XVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIFRvIGF2b2lkIHVucmVzb2x2ZWQgZmllbGQgb24gb3ZlcmxvYWRlZCBzY2hlbWFcbiAgICAgICAgICAgICAgLy8gcmVwbGFjZSB0aGUgZmluYWwgdHlwZSB3aXRoIHRoZSBhdXRvIHNjaGVtYSBvbmVcbiAgICAgICAgICAgICAgcGFyZW50W2tleV0gPSB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hLl90eXBlTWFwW3BhcmVudFtrZXldLm5hbWVdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAocGFyZW50W2tleV0ub2ZUeXBlKSB7XG4gICAgICAgICAgICAgIGZpbmRBbmRSZXBsYWNlTGFzdFR5cGUocGFyZW50W2tleV0sICdvZlR5cGUnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgICAgIC8vIEFkZCBub24gc2hhcmVkIHR5cGVzIGZyb20gY3VzdG9tIHNjaGVtYSB0byBhdXRvIHNjaGVtYVxuICAgICAgICAvLyBub3RlOiBzb21lIG5vbiBzaGFyZWQgdHlwZXMgY2FuIHVzZSBzb21lIHNoYXJlZCB0eXBlc1xuICAgICAgICAvLyBzbyB0aGlzIGNvZGUgbmVlZCB0byBiZSByYW4gYmVmb3JlIHRoZSBzaGFyZWQgdHlwZXMgYWRkaXRpb25cbiAgICAgICAgLy8gd2UgdXNlIHNvcnQgdG8gZW5zdXJlIHNjaGVtYSBjb25zaXN0ZW5jeSBvdmVyIHJlc3RhcnRzXG4gICAgICAgIE9iamVjdC5rZXlzKGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlTWFwKVxuICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgICAuZm9yRWFjaChjdXN0b21HcmFwaFFMU2NoZW1hVHlwZUtleSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZSA9IGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlTWFwW2N1c3RvbUdyYXBoUUxTY2hlbWFUeXBlS2V5XTtcbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgIWN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlIHx8XG4gICAgICAgICAgICAgICFjdXN0b21HcmFwaFFMU2NoZW1hVHlwZS5uYW1lIHx8XG4gICAgICAgICAgICAgIGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlLm5hbWUuc3RhcnRzV2l0aCgnX18nKVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IGF1dG9HcmFwaFFMU2NoZW1hVHlwZSA9IHRoaXMuZ3JhcGhRTEF1dG9TY2hlbWEuX3R5cGVNYXBbXG4gICAgICAgICAgICAgIGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlLm5hbWVcbiAgICAgICAgICAgIF07XG4gICAgICAgICAgICBpZiAoIWF1dG9HcmFwaFFMU2NoZW1hVHlwZSkge1xuICAgICAgICAgICAgICB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hLl90eXBlTWFwW1xuICAgICAgICAgICAgICAgIGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlLm5hbWVcbiAgICAgICAgICAgICAgXSA9IGN1c3RvbUdyYXBoUUxTY2hlbWFUeXBlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAvLyBIYW5kbGUgc2hhcmVkIHR5cGVzXG4gICAgICAgIC8vIFdlIHBhc3MgdGhyb3VnaCBlYWNoIHR5cGUgYW5kIGVuc3VyZSB0aGF0IGFsbCBzdWIgZmllbGQgdHlwZXMgYXJlIHJlcGxhY2VkXG4gICAgICAgIC8vIHdlIHVzZSBzb3J0IHRvIGVuc3VyZSBzY2hlbWEgY29uc2lzdGVuY3kgb3ZlciByZXN0YXJ0c1xuICAgICAgICBPYmplY3Qua2V5cyhjdXN0b21HcmFwaFFMU2NoZW1hVHlwZU1hcClcbiAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgLmZvckVhY2goY3VzdG9tR3JhcGhRTFNjaGVtYVR5cGVLZXkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tR3JhcGhRTFNjaGVtYVR5cGUgPSBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZU1hcFtjdXN0b21HcmFwaFFMU2NoZW1hVHlwZUtleV07XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICFjdXN0b21HcmFwaFFMU2NoZW1hVHlwZSB8fFxuICAgICAgICAgICAgICAhY3VzdG9tR3JhcGhRTFNjaGVtYVR5cGUubmFtZSB8fFxuICAgICAgICAgICAgICBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZS5uYW1lLnN0YXJ0c1dpdGgoJ19fJylcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBhdXRvR3JhcGhRTFNjaGVtYVR5cGUgPSB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hLl90eXBlTWFwW1xuICAgICAgICAgICAgICBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZS5uYW1lXG4gICAgICAgICAgICBdO1xuXG4gICAgICAgICAgICBpZiAoYXV0b0dyYXBoUUxTY2hlbWFUeXBlICYmIHR5cGVvZiBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZS5nZXRGaWVsZHMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgT2JqZWN0LmtleXMoY3VzdG9tR3JhcGhRTFNjaGVtYVR5cGUuX2ZpZWxkcylcbiAgICAgICAgICAgICAgICAuc29ydCgpXG4gICAgICAgICAgICAgICAgLmZvckVhY2goZmllbGRLZXkgPT4ge1xuICAgICAgICAgICAgICAgICAgY29uc3QgZmllbGQgPSBjdXN0b21HcmFwaFFMU2NoZW1hVHlwZS5fZmllbGRzW2ZpZWxkS2V5XTtcbiAgICAgICAgICAgICAgICAgIGZpbmRBbmRSZXBsYWNlTGFzdFR5cGUoZmllbGQsICd0eXBlJyk7XG4gICAgICAgICAgICAgICAgICBhdXRvR3JhcGhRTFNjaGVtYVR5cGUuX2ZpZWxkc1tmaWVsZC5uYW1lXSA9IGZpZWxkO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB0aGlzLmdyYXBoUUxTY2hlbWEgPSB0aGlzLmdyYXBoUUxBdXRvU2NoZW1hO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgdGhpcy5ncmFwaFFMQ3VzdG9tVHlwZURlZnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgdGhpcy5ncmFwaFFMU2NoZW1hID0gYXdhaXQgdGhpcy5ncmFwaFFMQ3VzdG9tVHlwZURlZnMoe1xuICAgICAgICAgIGRpcmVjdGl2ZXNEZWZpbml0aW9uc1NjaGVtYTogdGhpcy5ncmFwaFFMU2NoZW1hRGlyZWN0aXZlc0RlZmluaXRpb25zLFxuICAgICAgICAgIGF1dG9TY2hlbWE6IHRoaXMuZ3JhcGhRTEF1dG9TY2hlbWEsXG4gICAgICAgICAgZ3JhcGhRTFNjaGVtYURpcmVjdGl2ZXM6IHRoaXMuZ3JhcGhRTFNjaGVtYURpcmVjdGl2ZXMsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5ncmFwaFFMU2NoZW1hID0gbWVyZ2VTY2hlbWFzKHtcbiAgICAgICAgICBzY2hlbWFzOiBbdGhpcy5ncmFwaFFMQXV0b1NjaGVtYV0sXG4gICAgICAgICAgdHlwZURlZnM6IG1lcmdlVHlwZURlZnMoW1xuICAgICAgICAgICAgdGhpcy5ncmFwaFFMQ3VzdG9tVHlwZURlZnMsXG4gICAgICAgICAgICB0aGlzLmdyYXBoUUxTY2hlbWFEaXJlY3RpdmVzRGVmaW5pdGlvbnMsXG4gICAgICAgICAgXSksXG4gICAgICAgIH0pO1xuICAgICAgICB0aGlzLmdyYXBoUUxTY2hlbWEgPSB0aGlzLmdyYXBoUUxTY2hlbWFEaXJlY3RpdmVzKHRoaXMuZ3JhcGhRTFNjaGVtYSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuZ3JhcGhRTFNjaGVtYSA9IHRoaXMuZ3JhcGhRTEF1dG9TY2hlbWE7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuZ3JhcGhRTFNjaGVtYTtcbiAgfVxuXG4gIF9sb2dPbmNlKHNldmVyaXR5LCBtZXNzYWdlKSB7XG4gICAgaWYgKHRoaXMubG9nQ2FjaGVbbWVzc2FnZV0pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5sb2dbc2V2ZXJpdHldKG1lc3NhZ2UpO1xuICAgIHRoaXMubG9nQ2FjaGVbbWVzc2FnZV0gPSB0cnVlO1xuICB9XG5cbiAgYWRkR3JhcGhRTFR5cGUodHlwZSwgdGhyb3dFcnJvciA9IGZhbHNlLCBpZ25vcmVSZXNlcnZlZCA9IGZhbHNlLCBpZ25vcmVDb25uZWN0aW9uID0gZmFsc2UpIHtcbiAgICBpZiAoXG4gICAgICAoIWlnbm9yZVJlc2VydmVkICYmIFJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUy5pbmNsdWRlcyh0eXBlLm5hbWUpKSB8fFxuICAgICAgdGhpcy5ncmFwaFFMVHlwZXMuZmluZChleGlzdGluZ1R5cGUgPT4gZXhpc3RpbmdUeXBlLm5hbWUgPT09IHR5cGUubmFtZSkgfHxcbiAgICAgICghaWdub3JlQ29ubmVjdGlvbiAmJiB0eXBlLm5hbWUuZW5kc1dpdGgoJ0Nvbm5lY3Rpb24nKSlcbiAgICApIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgVHlwZSAke3R5cGUubmFtZX0gY291bGQgbm90IGJlIGFkZGVkIHRvIHRoZSBhdXRvIHNjaGVtYSBiZWNhdXNlIGl0IGNvbGxpZGVkIHdpdGggYW4gZXhpc3RpbmcgdHlwZS5gO1xuICAgICAgaWYgKHRocm93RXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgdGhpcy5fbG9nT25jZSgnd2FybicsIG1lc3NhZ2UpO1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgdGhpcy5ncmFwaFFMVHlwZXMucHVzaCh0eXBlKTtcbiAgICByZXR1cm4gdHlwZTtcbiAgfVxuXG4gIGFkZEdyYXBoUUxRdWVyeShmaWVsZE5hbWUsIGZpZWxkLCB0aHJvd0Vycm9yID0gZmFsc2UsIGlnbm9yZVJlc2VydmVkID0gZmFsc2UpIHtcbiAgICBpZiAoXG4gICAgICAoIWlnbm9yZVJlc2VydmVkICYmIFJFU0VSVkVEX0dSQVBIUUxfUVVFUllfTkFNRVMuaW5jbHVkZXMoZmllbGROYW1lKSkgfHxcbiAgICAgIHRoaXMuZ3JhcGhRTFF1ZXJpZXNbZmllbGROYW1lXVxuICAgICkge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGBRdWVyeSAke2ZpZWxkTmFtZX0gY291bGQgbm90IGJlIGFkZGVkIHRvIHRoZSBhdXRvIHNjaGVtYSBiZWNhdXNlIGl0IGNvbGxpZGVkIHdpdGggYW4gZXhpc3RpbmcgZmllbGQuYDtcbiAgICAgIGlmICh0aHJvd0Vycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2xvZ09uY2UoJ3dhcm4nLCBtZXNzYWdlKTtcbiAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgfVxuICAgIHRoaXMuZ3JhcGhRTFF1ZXJpZXNbZmllbGROYW1lXSA9IGZpZWxkO1xuICAgIHJldHVybiBmaWVsZDtcbiAgfVxuXG4gIGFkZEdyYXBoUUxNdXRhdGlvbihmaWVsZE5hbWUsIGZpZWxkLCB0aHJvd0Vycm9yID0gZmFsc2UsIGlnbm9yZVJlc2VydmVkID0gZmFsc2UpIHtcbiAgICBpZiAoXG4gICAgICAoIWlnbm9yZVJlc2VydmVkICYmIFJFU0VSVkVEX0dSQVBIUUxfTVVUQVRJT05fTkFNRVMuaW5jbHVkZXMoZmllbGROYW1lKSkgfHxcbiAgICAgIHRoaXMuZ3JhcGhRTE11dGF0aW9uc1tmaWVsZE5hbWVdXG4gICAgKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYE11dGF0aW9uICR7ZmllbGROYW1lfSBjb3VsZCBub3QgYmUgYWRkZWQgdG8gdGhlIGF1dG8gc2NoZW1hIGJlY2F1c2UgaXQgY29sbGlkZWQgd2l0aCBhbiBleGlzdGluZyBmaWVsZC5gO1xuICAgICAgaWYgKHRocm93RXJyb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgdGhpcy5fbG9nT25jZSgnd2FybicsIG1lc3NhZ2UpO1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gICAgdGhpcy5ncmFwaFFMTXV0YXRpb25zW2ZpZWxkTmFtZV0gPSBmaWVsZDtcbiAgICByZXR1cm4gZmllbGQ7XG4gIH1cblxuICBoYW5kbGVFcnJvcihlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFBhcnNlLkVycm9yKSB7XG4gICAgICB0aGlzLmxvZy5lcnJvcignUGFyc2UgZXJyb3I6ICcsIGVycm9yKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2cuZXJyb3IoJ1VuY2F1Z2h0IGludGVybmFsIHNlcnZlciBlcnJvci4nLCBlcnJvciwgZXJyb3Iuc3RhY2spO1xuICAgIH1cbiAgICB0aHJvdyB0b0dyYXBoUUxFcnJvcihlcnJvcik7XG4gIH1cblxuICBhc3luYyBfaW5pdGlhbGl6ZVNjaGVtYUFuZENvbmZpZygpIHtcbiAgICBjb25zdCBbc2NoZW1hQ29udHJvbGxlciwgcGFyc2VHcmFwaFFMQ29uZmlnXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIHRoaXMuZGF0YWJhc2VDb250cm9sbGVyLmxvYWRTY2hlbWEoKSxcbiAgICAgIHRoaXMucGFyc2VHcmFwaFFMQ29udHJvbGxlci5nZXRHcmFwaFFMQ29uZmlnKCksXG4gICAgXSk7XG5cbiAgICB0aGlzLnNjaGVtYUNvbnRyb2xsZXIgPSBzY2hlbWFDb250cm9sbGVyO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHBhcnNlR3JhcGhRTENvbmZpZyxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIEdldHMgYWxsIGNsYXNzZXMgZm91bmQgYnkgdGhlIGBzY2hlbWFDb250cm9sbGVyYFxuICAgKiBtaW51cyB0aG9zZSBmaWx0ZXJlZCBvdXQgYnkgdGhlIGFwcCdzIHBhcnNlR3JhcGhRTENvbmZpZy5cbiAgICovXG4gIGFzeW5jIF9nZXRDbGFzc2VzRm9yU2NoZW1hKHBhcnNlR3JhcGhRTENvbmZpZzogUGFyc2VHcmFwaFFMQ29uZmlnKSB7XG4gICAgY29uc3QgeyBlbmFibGVkRm9yQ2xhc3NlcywgZGlzYWJsZWRGb3JDbGFzc2VzIH0gPSBwYXJzZUdyYXBoUUxDb25maWc7XG4gICAgY29uc3QgYWxsQ2xhc3NlcyA9IGF3YWl0IHRoaXMuc2NoZW1hQ29udHJvbGxlci5nZXRBbGxDbGFzc2VzKCk7XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShlbmFibGVkRm9yQ2xhc3NlcykgfHwgQXJyYXkuaXNBcnJheShkaXNhYmxlZEZvckNsYXNzZXMpKSB7XG4gICAgICBsZXQgaW5jbHVkZWRDbGFzc2VzID0gYWxsQ2xhc3NlcztcbiAgICAgIGlmIChlbmFibGVkRm9yQ2xhc3Nlcykge1xuICAgICAgICBpbmNsdWRlZENsYXNzZXMgPSBhbGxDbGFzc2VzLmZpbHRlcihjbGF6eiA9PiB7XG4gICAgICAgICAgcmV0dXJuIGVuYWJsZWRGb3JDbGFzc2VzLmluY2x1ZGVzKGNsYXp6LmNsYXNzTmFtZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgaWYgKGRpc2FibGVkRm9yQ2xhc3Nlcykge1xuICAgICAgICAvLyBDbGFzc2VzIGluY2x1ZGVkIGluIGBlbmFibGVkRm9yQ2xhc3Nlc2AgdGhhdFxuICAgICAgICAvLyBhcmUgYWxzbyBwcmVzZW50IGluIGBkaXNhYmxlZEZvckNsYXNzZXNgIHdpbGxcbiAgICAgICAgLy8gc3RpbGwgYmUgZmlsdGVyZWQgb3V0XG4gICAgICAgIGluY2x1ZGVkQ2xhc3NlcyA9IGluY2x1ZGVkQ2xhc3Nlcy5maWx0ZXIoY2xhenogPT4ge1xuICAgICAgICAgIHJldHVybiAhZGlzYWJsZWRGb3JDbGFzc2VzLmluY2x1ZGVzKGNsYXp6LmNsYXNzTmFtZSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICB0aGlzLmlzVXNlcnNDbGFzc0Rpc2FibGVkID0gIWluY2x1ZGVkQ2xhc3Nlcy5zb21lKGNsYXp6ID0+IHtcbiAgICAgICAgcmV0dXJuIGNsYXp6LmNsYXNzTmFtZSA9PT0gJ19Vc2VyJztcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gaW5jbHVkZWRDbGFzc2VzO1xuICAgIH0gZWxzZSB7XG4gICAgICByZXR1cm4gYWxsQ2xhc3NlcztcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogVGhpcyBtZXRob2QgcmV0dXJucyBhIGxpc3Qgb2YgdHVwbGVzXG4gICAqIHRoYXQgcHJvdmlkZSB0aGUgcGFyc2VDbGFzcyBhbG9uZyB3aXRoXG4gICAqIGl0cyBwYXJzZUNsYXNzQ29uZmlnIHdoZXJlIHByb3ZpZGVkLlxuICAgKi9cbiAgX2dldFBhcnNlQ2xhc3Nlc1dpdGhDb25maWcocGFyc2VDbGFzc2VzLCBwYXJzZUdyYXBoUUxDb25maWc6IFBhcnNlR3JhcGhRTENvbmZpZykge1xuICAgIGNvbnN0IHsgY2xhc3NDb25maWdzIH0gPSBwYXJzZUdyYXBoUUxDb25maWc7XG5cbiAgICAvLyBNYWtlIHN1cmVzIHRoYXQgdGhlIGRlZmF1bHQgY2xhc3NlcyBhbmQgY2xhc3NlcyB0aGF0XG4gICAgLy8gc3RhcnRzIHdpdGggY2FwaXRhbGl6ZWQgbGV0dGVyIHdpbGwgYmUgZ2VuZXJhdGVkIGZpcnN0LlxuICAgIGNvbnN0IHNvcnRDbGFzc2VzID0gKGEsIGIpID0+IHtcbiAgICAgIGEgPSBhLmNsYXNzTmFtZTtcbiAgICAgIGIgPSBiLmNsYXNzTmFtZTtcbiAgICAgIGlmIChhWzBdID09PSAnXycpIHtcbiAgICAgICAgaWYgKGJbMF0gIT09ICdfJykge1xuICAgICAgICAgIHJldHVybiAtMTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGJbMF0gPT09ICdfJykge1xuICAgICAgICBpZiAoYVswXSAhPT0gJ18nKSB7XG4gICAgICAgICAgcmV0dXJuIDE7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChhID09PSBiKSB7XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfSBlbHNlIGlmIChhIDwgYikge1xuICAgICAgICByZXR1cm4gLTE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gMTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgcmV0dXJuIHBhcnNlQ2xhc3Nlcy5zb3J0KHNvcnRDbGFzc2VzKS5tYXAocGFyc2VDbGFzcyA9PiB7XG4gICAgICBsZXQgcGFyc2VDbGFzc0NvbmZpZztcbiAgICAgIGlmIChjbGFzc0NvbmZpZ3MpIHtcbiAgICAgICAgcGFyc2VDbGFzc0NvbmZpZyA9IGNsYXNzQ29uZmlncy5maW5kKGMgPT4gYy5jbGFzc05hbWUgPT09IHBhcnNlQ2xhc3MuY2xhc3NOYW1lKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbcGFyc2VDbGFzcywgcGFyc2VDbGFzc0NvbmZpZ107XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBfZ2V0RnVuY3Rpb25OYW1lcygpIHtcbiAgICByZXR1cm4gYXdhaXQgZ2V0RnVuY3Rpb25OYW1lcyh0aGlzLmFwcElkKS5maWx0ZXIoZnVuY3Rpb25OYW1lID0+IHtcbiAgICAgIGlmICgvXltfYS16QS1aXVtfYS16QS1aMC05XSokLy50ZXN0KGZ1bmN0aW9uTmFtZSkpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9sb2dPbmNlKFxuICAgICAgICAgICd3YXJuJyxcbiAgICAgICAgICBgRnVuY3Rpb24gJHtmdW5jdGlvbk5hbWV9IGNvdWxkIG5vdCBiZSBhZGRlZCB0byB0aGUgYXV0byBzY2hlbWEgYmVjYXVzZSBHcmFwaFFMIG5hbWVzIG11c3QgbWF0Y2ggL15bX2EtekEtWl1bX2EtekEtWjAtOV0qJC8uYFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogQ2hlY2tzIGZvciBjaGFuZ2VzIHRvIHRoZSBwYXJzZUNsYXNzZXNcbiAgICogb2JqZWN0cyAoaS5lLiBkYXRhYmFzZSBzY2hlbWEpIG9yIHRvXG4gICAqIHRoZSBwYXJzZUdyYXBoUUxDb25maWcgb2JqZWN0LiBJZiBub1xuICAgKiBjaGFuZ2VzIGFyZSBmb3VuZCwgcmV0dXJuIHRydWU7XG4gICAqL1xuICBfaGFzU2NoZW1hSW5wdXRDaGFuZ2VkKHBhcmFtczoge1xuICAgIHBhcnNlQ2xhc3NlczogYW55LFxuICAgIHBhcnNlR3JhcGhRTENvbmZpZzogP1BhcnNlR3JhcGhRTENvbmZpZyxcbiAgICBmdW5jdGlvbk5hbWVzU3RyaW5nOiBzdHJpbmcsXG4gIH0pOiBib29sZWFuIHtcbiAgICBjb25zdCB7IHBhcnNlQ2xhc3NlcywgcGFyc2VHcmFwaFFMQ29uZmlnLCBmdW5jdGlvbk5hbWVzU3RyaW5nIH0gPSBwYXJhbXM7XG5cbiAgICAvLyBGaXJzdCBpbml0XG4gICAgaWYgKCF0aGlzLmdyYXBoUUxTY2hlbWEpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGlmIChcbiAgICAgIGlzRGVlcFN0cmljdEVxdWFsKHRoaXMucGFyc2VHcmFwaFFMQ29uZmlnLCBwYXJzZUdyYXBoUUxDb25maWcpICYmXG4gICAgICB0aGlzLmZ1bmN0aW9uTmFtZXNTdHJpbmcgPT09IGZ1bmN0aW9uTmFtZXNTdHJpbmcgJiZcbiAgICAgIGlzRGVlcFN0cmljdEVxdWFsKHRoaXMucGFyc2VDbGFzc2VzLCBwYXJzZUNsYXNzZXMpXG4gICAgKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiB0cnVlO1xuICB9XG59XG5cbmV4cG9y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QUFDO01BQ1YsQ0FBQyxNQUFNLElBQUlELENBQUMsR0FBR0MsQ0FBQyxFQUFFO1FBQ2hCLE9BQU8sQ0FBQyxDQUFDO01BQ1gsQ0FBQyxNQUFNO1FBQ0wsT0FBTyxDQUFDO01BQ1Y7SUFDRixDQUFDO0lBRUQsT0FBT3BHLFlBQVksQ0FBQzBCLElBQUksQ0FBQ3dFLFdBQVcsQ0FBQyxDQUFDRyxHQUFHLENBQUNsRixVQUFVLElBQUk7TUFDdEQsSUFBSUMsZ0JBQWdCO01BQ3BCLElBQUk2RSxZQUFZLEVBQUU7UUFDaEI3RSxnQkFBZ0IsR0FBRzZFLFlBQVksQ0FBQzNCLElBQUksQ0FBQ2dDLENBQUMsSUFBSUEsQ0FBQyxDQUFDbEcsU0FBUyxLQUFLZSxVQUFVLENBQUNmLFNBQVMsQ0FBQztNQUNqRjtNQUNBLE9BQU8sQ0FBQ2UsVUFBVSxFQUFFQyxnQkFBZ0IsQ0FBQztJQUN2QyxDQUFDLENBQUM7RUFDSjtFQUVBLE1BQU12QixpQkFBaUJBLENBQUEsRUFBRztJQUN4QixPQUFPLE1BQU0sSUFBQTBHLDBCQUFnQixFQUFDLElBQUksQ0FBQ3BILEtBQUssQ0FBQyxDQUFDMkcsTUFBTSxDQUFDVSxZQUFZLElBQUk7TUFDL0QsSUFBSSwwQkFBMEIsQ0FBQ0MsSUFBSSxDQUFDRCxZQUFZLENBQUMsRUFBRTtRQUNqRCxPQUFPLElBQUk7TUFDYixDQUFDLE1BQU07UUFDTCxJQUFJLENBQUMxQyxRQUFRLENBQ1gsTUFBTSxFQUNOLFlBQVkwQyxZQUFZLHFHQUMxQixDQUFDO1FBQ0QsT0FBTyxLQUFLO01BQ2Q7SUFDRixDQUFDLENBQUM7RUFDSjs7RUFFQTtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRW5HLHNCQUFzQkEsQ0FBQ3hCLE1BSXRCLEVBQVc7SUFDVixNQUFNO01BQUVtQixZQUFZO01BQUVSLGtCQUFrQjtNQUFFTTtJQUFvQixDQUFDLEdBQUdqQixNQUFNOztJQUV4RTtJQUNBLElBQUksQ0FBQyxJQUFJLENBQUN5QixhQUFhLEVBQUU7TUFDdkIsT0FBTyxJQUFJO0lBQ2I7SUFFQSxJQUNFLElBQUFvRyx1QkFBaUIsRUFBQyxJQUFJLENBQUNsSCxrQkFBa0IsRUFBRUEsa0JBQWtCLENBQUMsSUFDOUQsSUFBSSxDQUFDTSxtQkFBbUIsS0FBS0EsbUJBQW1CLElBQ2hELElBQUE0Ryx1QkFBaUIsRUFBQyxJQUFJLENBQUMxRyxZQUFZLEVBQUVBLFlBQVksQ0FBQyxFQUNsRDtNQUNBLE9BQU8sS0FBSztJQUNkO0lBQ0EsT0FBTyxJQUFJO0VBQ2I7QUFDRjtBQUFDeEIsT0FBQSxDQUFBRyxrQkFBQSxHQUFBQSxrQkFBQSIsImlnbm9yZUxpc3QiOltdfQ==