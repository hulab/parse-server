"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseGraphQLServer = void 0;
var _graphqlUploadExpress = _interopRequireDefault(require("graphql-upload/graphqlUploadExpress.js"));
var _server = require("@apollo/server");
var _express = require("@as-integrations/express5");
var _disabled = require("@apollo/server/plugin/disabled");
var _express2 = _interopRequireDefault(require("express"));
var _graphql = require("graphql");
var _middlewares = require("../middlewares");
var _requiredParameter = _interopRequireDefault(require("../requiredParameter"));
var _logger = _interopRequireDefault(require("../logger"));
var _ParseGraphQLSchema = require("./ParseGraphQLSchema");
var _ParseGraphQLController = _interopRequireWildcard(require("../Controllers/ParseGraphQLController"));
var _queryComplexity = require("./helpers/queryComplexity");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
const hasTypeIntrospection = query => {
  try {
    const ast = (0, _graphql.parse)(query);
    const checkSelections = selections => {
      for (const selection of selections) {
        if (selection.kind === 'Field' && selection.name.value === '__type') {
          if (selection.arguments && selection.arguments.length > 0) {
            return true;
          }
        }
        if (selection.selectionSet) {
          if (checkSelections(selection.selectionSet.selections)) {
            return true;
          }
        }
      }
      return false;
    };
    for (const definition of ast.definitions) {
      if (definition.selectionSet) {
        if (checkSelections(definition.selectionSet.selections)) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
};
const throwIntrospectionError = () => {
  throw new _graphql.GraphQLError('Introspection is not allowed', {
    extensions: {
      http: {
        status: 403
      }
    }
  });
};
const IntrospectionControlPlugin = publicIntrospection => ({
  requestDidStart: requestContext => ({
    didResolveOperation: async () => {
      // If public introspection is enabled, we allow all introspection queries
      if (publicIntrospection) {
        return;
      }
      const isMasterOrMaintenance = requestContext.contextValue.auth?.isMaster || requestContext.contextValue.auth?.isMaintenance;
      if (isMasterOrMaintenance) {
        return;
      }
      const query = requestContext.request.query;

      // Fast path: simple string check for __schema
      // This avoids parsing the query in most cases
      if (query?.includes('__schema')) {
        return throwIntrospectionError();
      }

      // Smart check for __type: only parse if the string is present
      // This avoids false positives (e.g., "__type" in strings or comments)
      // while still being efficient for the common case
      if (query?.includes('__type') && hasTypeIntrospection(query)) {
        return throwIntrospectionError();
      }
    }
  })
});

// graphql-js embeds "Did you mean ...?" hints sourced from the live schema in
// its error messages. They are produced in two distinct phases:
//   - validation rules (FieldsOnCorrectTypeRule, KnownArgumentNamesRule,
//     KnownTypeNamesRule, ...), and
//   - variable coercion (unknown enum values, unknown input-object fields),
//     which runs during execution, after validation.
// All of these are returned to the caller and disclose schema identifiers (Cloud
// Code function names, class and field names) that the introspection guard is
// meant to hide. Strip the hint suffix from every returned error — including the
// copy graphql-js duplicates into extensions.stacktrace in non-production — for
// callers that are not allowed to introspect.
const stripSchemaSuggestion = message => typeof message === 'string' ? message.replace(/ ?Did you mean(.+?)\?$/, '') : message;

// graphql-js also emits a base input-coercion message that names a schema
// identifier WITHOUT a "Did you mean" clause, so the suggestion strip above
// cannot reach it: when a required custom input field is omitted, coerceInputValue
// returns 'Field "<name>" of required type "<type>" was not provided.', disclosing
// a field name the caller never supplied. Redact the quoted identifiers from this
// template while preserving the error shape, for callers that are not allowed to
// introspect. The sibling coercion messages ('... is not defined by type "<type>".',
// 'Expected type "<type>" to be an object.') are intentionally left intact: they
// only echo an input type name the caller already referenced in the operation, so
// they disclose nothing the caller did not already provide.
const stripSchemaCoercionIdentifiers = message => typeof message === 'string' ? message.replace(/Field "[^"]*" of required type "[^"]*" was not provided\./g, 'Field of required type was not provided.') : message;

// graphql-js also emits base coercion / validation messages that name a nested input
// TYPE without a "Did you mean" clause, so neither strip above reaches them. For a
// Pointer or Relation field the generated input type name embeds the pointer's TARGET
// class (`<Target>PointerInput`, `<Target>RelationWhereInput`, `Create<Target>FieldsInput`)
// — a class the caller never referenced and cannot derive from the field name they
// supplied — so these templates disclose a schema class name to a caller who has only the
// public application id. Redact the quoted type identifier from those templates UNLESS the
// caller referenced it in the operation text: a type name the caller wrote in the operation
// (e.g. `$where: UserWhereInput`) is not a disclosure, and preserving it keeps the message
// ('... is not defined by type "UserWhereInput".') useful. When the operation text is
// unavailable the identifier is redacted (fail closed).
const stripSchemaTypeIdentifiers = (message, operationText) => {
  if (typeof message !== 'string') {
    return message;
  }
  // A generated type identifier counts as "referenced" (and therefore not a disclosure) only if
  // the caller wrote it as a whole token in the operation text. Tokenize the operation on
  // non-identifier characters and compare exact tokens rather than building a RegExp from the
  // captured name: this avoids substring false-matches (e.g. preserving "AuthorPointerInput"
  // because the operation contains "SecretAuthorPointerInput") and any regex injection/ReDoS from
  // an unusual captured name. GraphQL list/non-null wrappers ("[", "]", "!") are stripped from the
  // captured name so e.g. "SecretAuthorPointerInput!" still matches "$x: SecretAuthorPointerInput!".
  // When the operation text is unavailable the type is treated as not referenced (fail closed).
  const referencedTokens = typeof operationText === 'string' ? new Set(operationText.split(/[^_A-Za-z0-9]+/).filter(Boolean)) : new Set();
  const isReferenced = typeName => referencedTokens.has(typeName.replace(/[[\]!]/g, ''));
  return message
  // Input coercion / ValuesOfCorrectTypeRule (variables and inline literals).
  .replace(/Expected value of type "([^"]+)"/g, (match, typeName) => isReferenced(typeName) ? match : 'Expected value of the correct type').replace(/Expected type "([^"]+)" to be an object\./g, (match, typeName) => isReferenced(typeName) ? match : 'Expected an object.').replace(/Expected non-nullable type "([^"]+)" not to be null\./g, (match, typeName) => isReferenced(typeName) ? match : 'Expected a non-null value.').replace(/ is not defined by type "([^"]+)"\./g, (match, typeName) => isReferenced(typeName) ? match : ' is not defined.')
  // VariablesInAllowedPositionRule: the position type is the pointer/relation target
  // input type; the caller only wrote their own variable's declared type.
  .replace(/ used in position expecting type "([^"]+)"\./g, (match, typeName) => isReferenced(typeName) ? match : ' used in position expecting a different type.')
  // FieldsOnCorrectTypeRule: descending into a Pointer/Relation output field names its
  // target output object type.
  .replace(/Cannot query field ("[^"]*") on type "([^"]+)"\./g, (match, fieldName, typeName) => isReferenced(typeName) ? match : `Cannot query field ${fieldName}.`)
  // ScalarLeafsRule: selecting a Pointer/Relation output field with no sub-selection names
  // its target output object type.
  .replace(/Field ("[^"]*") of type "([^"]+)" must have a selection of subfields\./g, (match, fieldName, typeName) => isReferenced(typeName) ? match : `Field ${fieldName} must have a selection of subfields.`)
  // PossibleFragmentSpreadsRule: an inline/named fragment on an incompatible type inside a
  // Pointer/Relation output field names the target output object type (the parent type).
  // Redact each type token the caller did not reference; when both are referenced the
  // reconstruction is identical to the original message.
  .replace(/objects of type "([^"]+)" can never be of type "([^"]+)"\./g, (match, parentType, fragType) => {
    const parent = isReferenced(parentType) ? `type "${parentType}"` : 'the parent type';
    const frag = isReferenced(fragType) ? `type "${fragType}"` : 'the given type';
    return `objects of ${parent} can never be of ${frag}.`;
  });
};
const stripSchemaIdentifiers = (message, operationText) => stripSchemaTypeIdentifiers(stripSchemaCoercionIdentifiers(stripSchemaSuggestion(message)), operationText);
const SchemaSuggestionsControlPlugin = publicIntrospection => ({
  requestDidStart: async requestContext => ({
    willSendResponse: async () => {
      if (publicIntrospection) {
        return;
      }
      const isMasterOrMaintenance = requestContext.contextValue.auth?.isMaster || requestContext.contextValue.auth?.isMaintenance;
      if (isMasterOrMaintenance) {
        return;
      }
      const body = requestContext.response?.body;
      const errors = body?.kind === 'single' ? body.singleResult.errors : body?.kind === 'incremental' ? body.initialResult.errors : undefined;
      const operationText = requestContext.request?.query;
      errors?.forEach(error => {
        error.message = stripSchemaIdentifiers(error.message, operationText);
        if (Array.isArray(error.extensions?.stacktrace)) {
          error.extensions.stacktrace = error.extensions.stacktrace.map(message => stripSchemaIdentifiers(message, operationText));
        }
      });
    }
  })
});
class ParseGraphQLServer {
  constructor(parseServer, config) {
    this.parseServer = parseServer || (0, _requiredParameter.default)('You must provide a parseServer instance!');
    if (!config || !config.graphQLPath) {
      (0, _requiredParameter.default)('You must provide a config.graphQLPath!');
    }
    this.config = config;
    this.parseGraphQLController = this.parseServer.config.parseGraphQLController;
    this.log = this.parseServer.config && this.parseServer.config.loggerController || _logger.default;
    this.parseGraphQLSchema = new _ParseGraphQLSchema.ParseGraphQLSchema({
      parseGraphQLController: this.parseGraphQLController,
      databaseController: this.parseServer.config.databaseController,
      log: this.log,
      graphQLCustomTypeDefs: this.config.graphQLCustomTypeDefs,
      appId: this.parseServer.config.appId
    });
  }
  async _getGraphQLOptions() {
    try {
      return {
        schema: await this.parseGraphQLSchema.load(),
        context: async ({
          req
        }) => {
          return {
            info: req.info,
            config: req.config,
            auth: req.auth
          };
        }
      };
    } catch (e) {
      this.log.error(e.stack || typeof e.toString === 'function' && e.toString() || e);
      throw e;
    }
  }
  async _getServer() {
    const schemaRef = this.parseGraphQLSchema.graphQLSchema;
    const newSchemaRef = await this.parseGraphQLSchema.load();
    if (schemaRef === newSchemaRef && this._server) {
      return this._server;
    }
    // It means a parallel _getServer call is already in progress
    if (this._schemaRefMutex === newSchemaRef) {
      return this._server;
    }
    // Update the schema ref mutex to avoid parallel _getServer calls
    this._schemaRefMutex = newSchemaRef;
    const createServer = async () => {
      try {
        const {
          schema,
          context
        } = await this._getGraphQLOptions();
        const apollo = new _server.ApolloServer({
          csrfPrevention: {
            // See https://www.apollographql.com/docs/router/configuration/csrf/
            // needed since we use graphql upload
            requestHeaders: ['X-Parse-Application-Id']
          },
          // We need always true introspection because apollo server have changing behavior based on the NODE_ENV variable
          // we delegate the introspection control to the IntrospectionControlPlugin
          introspection: true,
          plugins: [(0, _disabled.ApolloServerPluginCacheControlDisabled)(), IntrospectionControlPlugin(this.config.graphQLPublicIntrospection), SchemaSuggestionsControlPlugin(this.config.graphQLPublicIntrospection), (0, _queryComplexity.createComplexityValidationPlugin)(() => this.parseServer.config.requestComplexity)],
          schema
        });
        await apollo.start();
        return (0, _express.expressMiddleware)(apollo, {
          context
        });
      } catch (e) {
        // Reset all mutexes and forward the error
        this._server = null;
        this._schemaRefMutex = null;
        throw e;
      }
    };
    // Do not await so parallel request will wait the same promise ref
    this._server = createServer();
    return this._server;
  }
  _transformMaxUploadSizeToBytes(maxUploadSize) {
    const unitMap = {
      kb: 1,
      mb: 2,
      gb: 3
    };
    return Number(maxUploadSize.slice(0, -2)) * Math.pow(1024, unitMap[maxUploadSize.slice(-2).toLowerCase()]);
  }

  /**
   * @static
   * Allow developers to customize each request with inversion of control/dependency injection
   */
  applyRequestContextMiddleware(api, options) {
    if (options.requestContextMiddleware) {
      if (typeof options.requestContextMiddleware !== 'function') {
        throw new Error('requestContextMiddleware must be a function');
      }
      api.use(this.config.graphQLPath, options.requestContextMiddleware);
    }
  }
  applyGraphQL(app) {
    if (!app || !app.use) {
      (0, _requiredParameter.default)('You must provide an Express.js app instance!');
    }
    app.use(this.config.graphQLPath, (0, _middlewares.allowCrossDomain)(this.parseServer.config.appId));
    app.use(this.config.graphQLPath, _middlewares.handleParseHeaders);
    app.use(this.config.graphQLPath, _middlewares.handleParseSession);
    this.applyRequestContextMiddleware(app, this.parseServer.config);
    app.use(this.config.graphQLPath, _middlewares.handleParseErrors);
    app.use(this.config.graphQLPath, (0, _graphqlUploadExpress.default)({
      maxFileSize: this._transformMaxUploadSizeToBytes(this.parseServer.config.maxUploadSize || '20mb')
    }));
    app.use(this.config.graphQLPath, _express2.default.json(), async (req, res, next) => {
      const server = await this._getServer();
      return server(req, res, next);
    });
  }
  applyPlayground(app) {
    if (!app || !app.get) {
      (0, _requiredParameter.default)('You must provide an Express.js app instance!');
    }
    app.get(this.config.playgroundPath || (0, _requiredParameter.default)('You must provide a config.playgroundPath to applyPlayground!'), (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.write(`<div id="sandbox" style="position:absolute;top:0;right:0;bottom:0;left:0"></div>
          <script src="https://embeddable-sandbox.cdn.apollographql.com/_latest/embeddable-sandbox.umd.production.min.js"></script>
          <script>
           new window.EmbeddedSandbox({
             target: "#sandbox",
             endpointIsEditable: false,
             initialEndpoint: ${JSON.stringify(this.config.graphQLPath)},
             handleRequest: (endpointUrl, options) => {
              return fetch(endpointUrl, {
                ...options,
                headers: {
                    ...options.headers,
                    'X-Parse-Application-Id': ${JSON.stringify(this.parseServer.config.appId)},
                    'X-Parse-Master-Key': ${JSON.stringify(this.parseServer.config.masterKey)},
                },
              })
            },
           });
           // advanced options: https://www.apollographql.com/docs/studio/explorer/sandbox#embedding-sandbox
          </script>`);
      res.end();
    });
  }
  setGraphQLConfig(graphQLConfig) {
    return this.parseGraphQLController.updateGraphQLConfig(graphQLConfig);
  }
}
exports.ParseGraphQLServer = ParseGraphQLServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZ3JhcGhxbFVwbG9hZEV4cHJlc3MiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9zZXJ2ZXIiLCJfZXhwcmVzcyIsIl9kaXNhYmxlZCIsIl9leHByZXNzMiIsIl9ncmFwaHFsIiwiX21pZGRsZXdhcmVzIiwiX3JlcXVpcmVkUGFyYW1ldGVyIiwiX2xvZ2dlciIsIl9QYXJzZUdyYXBoUUxTY2hlbWEiLCJfUGFyc2VHcmFwaFFMQ29udHJvbGxlciIsIl9pbnRlcm9wUmVxdWlyZVdpbGRjYXJkIiwiX3F1ZXJ5Q29tcGxleGl0eSIsImUiLCJ0IiwiV2Vha01hcCIsInIiLCJuIiwiX19lc01vZHVsZSIsIm8iLCJpIiwiZiIsIl9fcHJvdG9fXyIsImRlZmF1bHQiLCJoYXMiLCJnZXQiLCJzZXQiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJPYmplY3QiLCJkZWZpbmVQcm9wZXJ0eSIsImdldE93blByb3BlcnR5RGVzY3JpcHRvciIsImhhc1R5cGVJbnRyb3NwZWN0aW9uIiwicXVlcnkiLCJhc3QiLCJwYXJzZSIsImNoZWNrU2VsZWN0aW9ucyIsInNlbGVjdGlvbnMiLCJzZWxlY3Rpb24iLCJraW5kIiwibmFtZSIsInZhbHVlIiwiYXJndW1lbnRzIiwibGVuZ3RoIiwic2VsZWN0aW9uU2V0IiwiZGVmaW5pdGlvbiIsImRlZmluaXRpb25zIiwidGhyb3dJbnRyb3NwZWN0aW9uRXJyb3IiLCJHcmFwaFFMRXJyb3IiLCJleHRlbnNpb25zIiwiaHR0cCIsInN0YXR1cyIsIkludHJvc3BlY3Rpb25Db250cm9sUGx1Z2luIiwicHVibGljSW50cm9zcGVjdGlvbiIsInJlcXVlc3REaWRTdGFydCIsInJlcXVlc3RDb250ZXh0IiwiZGlkUmVzb2x2ZU9wZXJhdGlvbiIsImlzTWFzdGVyT3JNYWludGVuYW5jZSIsImNvbnRleHRWYWx1ZSIsImF1dGgiLCJpc01hc3RlciIsImlzTWFpbnRlbmFuY2UiLCJyZXF1ZXN0IiwiaW5jbHVkZXMiLCJzdHJpcFNjaGVtYVN1Z2dlc3Rpb24iLCJtZXNzYWdlIiwicmVwbGFjZSIsInN0cmlwU2NoZW1hQ29lcmNpb25JZGVudGlmaWVycyIsInN0cmlwU2NoZW1hVHlwZUlkZW50aWZpZXJzIiwib3BlcmF0aW9uVGV4dCIsInJlZmVyZW5jZWRUb2tlbnMiLCJTZXQiLCJzcGxpdCIsImZpbHRlciIsIkJvb2xlYW4iLCJpc1JlZmVyZW5jZWQiLCJ0eXBlTmFtZSIsIm1hdGNoIiwiZmllbGROYW1lIiwicGFyZW50VHlwZSIsImZyYWdUeXBlIiwicGFyZW50IiwiZnJhZyIsInN0cmlwU2NoZW1hSWRlbnRpZmllcnMiLCJTY2hlbWFTdWdnZXN0aW9uc0NvbnRyb2xQbHVnaW4iLCJ3aWxsU2VuZFJlc3BvbnNlIiwiYm9keSIsInJlc3BvbnNlIiwiZXJyb3JzIiwic2luZ2xlUmVzdWx0IiwiaW5pdGlhbFJlc3VsdCIsInVuZGVmaW5lZCIsImZvckVhY2giLCJlcnJvciIsIkFycmF5IiwiaXNBcnJheSIsInN0YWNrdHJhY2UiLCJtYXAiLCJQYXJzZUdyYXBoUUxTZXJ2ZXIiLCJjb25zdHJ1Y3RvciIsInBhcnNlU2VydmVyIiwiY29uZmlnIiwicmVxdWlyZWRQYXJhbWV0ZXIiLCJncmFwaFFMUGF0aCIsInBhcnNlR3JhcGhRTENvbnRyb2xsZXIiLCJsb2ciLCJsb2dnZXJDb250cm9sbGVyIiwiZGVmYXVsdExvZ2dlciIsInBhcnNlR3JhcGhRTFNjaGVtYSIsIlBhcnNlR3JhcGhRTFNjaGVtYSIsImRhdGFiYXNlQ29udHJvbGxlciIsImdyYXBoUUxDdXN0b21UeXBlRGVmcyIsImFwcElkIiwiX2dldEdyYXBoUUxPcHRpb25zIiwic2NoZW1hIiwibG9hZCIsImNvbnRleHQiLCJyZXEiLCJpbmZvIiwic3RhY2siLCJ0b1N0cmluZyIsIl9nZXRTZXJ2ZXIiLCJzY2hlbWFSZWYiLCJncmFwaFFMU2NoZW1hIiwibmV3U2NoZW1hUmVmIiwiX3NjaGVtYVJlZk11dGV4IiwiY3JlYXRlU2VydmVyIiwiYXBvbGxvIiwiQXBvbGxvU2VydmVyIiwiY3NyZlByZXZlbnRpb24iLCJyZXF1ZXN0SGVhZGVycyIsImludHJvc3BlY3Rpb24iLCJwbHVnaW5zIiwiQXBvbGxvU2VydmVyUGx1Z2luQ2FjaGVDb250cm9sRGlzYWJsZWQiLCJncmFwaFFMUHVibGljSW50cm9zcGVjdGlvbiIsImNyZWF0ZUNvbXBsZXhpdHlWYWxpZGF0aW9uUGx1Z2luIiwicmVxdWVzdENvbXBsZXhpdHkiLCJzdGFydCIsImV4cHJlc3NNaWRkbGV3YXJlIiwiX3RyYW5zZm9ybU1heFVwbG9hZFNpemVUb0J5dGVzIiwibWF4VXBsb2FkU2l6ZSIsInVuaXRNYXAiLCJrYiIsIm1iIiwiZ2IiLCJOdW1iZXIiLCJzbGljZSIsIk1hdGgiLCJwb3ciLCJ0b0xvd2VyQ2FzZSIsImFwcGx5UmVxdWVzdENvbnRleHRNaWRkbGV3YXJlIiwiYXBpIiwib3B0aW9ucyIsInJlcXVlc3RDb250ZXh0TWlkZGxld2FyZSIsIkVycm9yIiwidXNlIiwiYXBwbHlHcmFwaFFMIiwiYXBwIiwiYWxsb3dDcm9zc0RvbWFpbiIsImhhbmRsZVBhcnNlSGVhZGVycyIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsImhhbmRsZVBhcnNlRXJyb3JzIiwiZ3JhcGhxbFVwbG9hZEV4cHJlc3MiLCJtYXhGaWxlU2l6ZSIsImV4cHJlc3MiLCJqc29uIiwicmVzIiwibmV4dCIsInNlcnZlciIsImFwcGx5UGxheWdyb3VuZCIsInBsYXlncm91bmRQYXRoIiwiX3JlcSIsInNldEhlYWRlciIsIndyaXRlIiwiSlNPTiIsInN0cmluZ2lmeSIsIm1hc3RlcktleSIsImVuZCIsInNldEdyYXBoUUxDb25maWciLCJncmFwaFFMQ29uZmlnIiwidXBkYXRlR3JhcGhRTENvbmZpZyIsImV4cG9ydHMiXSwic291cmNlcyI6WyIuLi8uLi9zcmMvR3JhcGhRTC9QYXJzZUdyYXBoUUxTZXJ2ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGdyYXBocWxVcGxvYWRFeHByZXNzIGZyb20gJ2dyYXBocWwtdXBsb2FkL2dyYXBocWxVcGxvYWRFeHByZXNzLmpzJztcbmltcG9ydCB7IEFwb2xsb1NlcnZlciB9IGZyb20gJ0BhcG9sbG8vc2VydmVyJztcbmltcG9ydCB7IGV4cHJlc3NNaWRkbGV3YXJlIH0gZnJvbSAnQGFzLWludGVncmF0aW9ucy9leHByZXNzNSc7XG5pbXBvcnQgeyBBcG9sbG9TZXJ2ZXJQbHVnaW5DYWNoZUNvbnRyb2xEaXNhYmxlZCB9IGZyb20gJ0BhcG9sbG8vc2VydmVyL3BsdWdpbi9kaXNhYmxlZCc7XG5pbXBvcnQgZXhwcmVzcyBmcm9tICdleHByZXNzJztcbmltcG9ydCB7IEdyYXBoUUxFcnJvciwgcGFyc2UgfSBmcm9tICdncmFwaHFsJztcbmltcG9ydCB7IGFsbG93Q3Jvc3NEb21haW4sIGhhbmRsZVBhcnNlRXJyb3JzLCBoYW5kbGVQYXJzZUhlYWRlcnMsIGhhbmRsZVBhcnNlU2Vzc2lvbiB9IGZyb20gJy4uL21pZGRsZXdhcmVzJztcbmltcG9ydCByZXF1aXJlZFBhcmFtZXRlciBmcm9tICcuLi9yZXF1aXJlZFBhcmFtZXRlcic7XG5pbXBvcnQgZGVmYXVsdExvZ2dlciBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IHsgUGFyc2VHcmFwaFFMU2NoZW1hIH0gZnJvbSAnLi9QYXJzZUdyYXBoUUxTY2hlbWEnO1xuaW1wb3J0IFBhcnNlR3JhcGhRTENvbnRyb2xsZXIsIHsgUGFyc2VHcmFwaFFMQ29uZmlnIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMvUGFyc2VHcmFwaFFMQ29udHJvbGxlcic7XG5pbXBvcnQgeyBjcmVhdGVDb21wbGV4aXR5VmFsaWRhdGlvblBsdWdpbiB9IGZyb20gJy4vaGVscGVycy9xdWVyeUNvbXBsZXhpdHknO1xuXG5cbmNvbnN0IGhhc1R5cGVJbnRyb3NwZWN0aW9uID0gKHF1ZXJ5KSA9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgYXN0ID0gcGFyc2UocXVlcnkpO1xuICAgIGNvbnN0IGNoZWNrU2VsZWN0aW9ucyA9IChzZWxlY3Rpb25zKSA9PiB7XG4gICAgICBmb3IgKGNvbnN0IHNlbGVjdGlvbiBvZiBzZWxlY3Rpb25zKSB7XG4gICAgICAgIGlmIChzZWxlY3Rpb24ua2luZCA9PT0gJ0ZpZWxkJyAmJiBzZWxlY3Rpb24ubmFtZS52YWx1ZSA9PT0gJ19fdHlwZScpIHtcbiAgICAgICAgICBpZiAoc2VsZWN0aW9uLmFyZ3VtZW50cyAmJiBzZWxlY3Rpb24uYXJndW1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBpZiAoc2VsZWN0aW9uLnNlbGVjdGlvblNldCkge1xuICAgICAgICAgIGlmIChjaGVja1NlbGVjdGlvbnMoc2VsZWN0aW9uLnNlbGVjdGlvblNldC5zZWxlY3Rpb25zKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfTtcbiAgICBmb3IgKGNvbnN0IGRlZmluaXRpb24gb2YgYXN0LmRlZmluaXRpb25zKSB7XG4gICAgICBpZiAoZGVmaW5pdGlvbi5zZWxlY3Rpb25TZXQpIHtcbiAgICAgICAgaWYgKGNoZWNrU2VsZWN0aW9ucyhkZWZpbml0aW9uLnNlbGVjdGlvblNldC5zZWxlY3Rpb25zKSkge1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59O1xuXG5jb25zdCB0aHJvd0ludHJvc3BlY3Rpb25FcnJvciA9ICgpID0+IHtcbiAgdGhyb3cgbmV3IEdyYXBoUUxFcnJvcignSW50cm9zcGVjdGlvbiBpcyBub3QgYWxsb3dlZCcsIHtcbiAgICBleHRlbnNpb25zOiB7XG4gICAgICBodHRwOiB7XG4gICAgICAgIHN0YXR1czogNDAzLFxuICAgICAgfSxcbiAgICB9XG4gIH0pO1xufTtcblxuY29uc3QgSW50cm9zcGVjdGlvbkNvbnRyb2xQbHVnaW4gPSAocHVibGljSW50cm9zcGVjdGlvbikgPT4gKHtcblxuXG4gIHJlcXVlc3REaWRTdGFydDogKHJlcXVlc3RDb250ZXh0KSA9PiAoe1xuXG4gICAgZGlkUmVzb2x2ZU9wZXJhdGlvbjogYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gSWYgcHVibGljIGludHJvc3BlY3Rpb24gaXMgZW5hYmxlZCwgd2UgYWxsb3cgYWxsIGludHJvc3BlY3Rpb24gcXVlcmllc1xuICAgICAgaWYgKHB1YmxpY0ludHJvc3BlY3Rpb24pIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpc01hc3Rlck9yTWFpbnRlbmFuY2UgPSByZXF1ZXN0Q29udGV4dC5jb250ZXh0VmFsdWUuYXV0aD8uaXNNYXN0ZXIgfHwgcmVxdWVzdENvbnRleHQuY29udGV4dFZhbHVlLmF1dGg/LmlzTWFpbnRlbmFuY2VcbiAgICAgIGlmIChpc01hc3Rlck9yTWFpbnRlbmFuY2UpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBxdWVyeSA9IHJlcXVlc3RDb250ZXh0LnJlcXVlc3QucXVlcnk7XG5cblxuICAgICAgLy8gRmFzdCBwYXRoOiBzaW1wbGUgc3RyaW5nIGNoZWNrIGZvciBfX3NjaGVtYVxuICAgICAgLy8gVGhpcyBhdm9pZHMgcGFyc2luZyB0aGUgcXVlcnkgaW4gbW9zdCBjYXNlc1xuICAgICAgaWYgKHF1ZXJ5Py5pbmNsdWRlcygnX19zY2hlbWEnKSkge1xuICAgICAgICByZXR1cm4gdGhyb3dJbnRyb3NwZWN0aW9uRXJyb3IoKTtcbiAgICAgIH1cblxuICAgICAgLy8gU21hcnQgY2hlY2sgZm9yIF9fdHlwZTogb25seSBwYXJzZSBpZiB0aGUgc3RyaW5nIGlzIHByZXNlbnRcbiAgICAgIC8vIFRoaXMgYXZvaWRzIGZhbHNlIHBvc2l0aXZlcyAoZS5nLiwgXCJfX3R5cGVcIiBpbiBzdHJpbmdzIG9yIGNvbW1lbnRzKVxuICAgICAgLy8gd2hpbGUgc3RpbGwgYmVpbmcgZWZmaWNpZW50IGZvciB0aGUgY29tbW9uIGNhc2VcbiAgICAgIGlmIChxdWVyeT8uaW5jbHVkZXMoJ19fdHlwZScpICYmIGhhc1R5cGVJbnRyb3NwZWN0aW9uKHF1ZXJ5KSkge1xuICAgICAgICByZXR1cm4gdGhyb3dJbnRyb3NwZWN0aW9uRXJyb3IoKTtcbiAgICAgIH1cbiAgICB9LFxuXG4gIH0pXG5cbn0pO1xuXG4vLyBncmFwaHFsLWpzIGVtYmVkcyBcIkRpZCB5b3UgbWVhbiAuLi4/XCIgaGludHMgc291cmNlZCBmcm9tIHRoZSBsaXZlIHNjaGVtYSBpblxuLy8gaXRzIGVycm9yIG1lc3NhZ2VzLiBUaGV5IGFyZSBwcm9kdWNlZCBpbiB0d28gZGlzdGluY3QgcGhhc2VzOlxuLy8gICAtIHZhbGlkYXRpb24gcnVsZXMgKEZpZWxkc09uQ29ycmVjdFR5cGVSdWxlLCBLbm93bkFyZ3VtZW50TmFtZXNSdWxlLFxuLy8gICAgIEtub3duVHlwZU5hbWVzUnVsZSwgLi4uKSwgYW5kXG4vLyAgIC0gdmFyaWFibGUgY29lcmNpb24gKHVua25vd24gZW51bSB2YWx1ZXMsIHVua25vd24gaW5wdXQtb2JqZWN0IGZpZWxkcyksXG4vLyAgICAgd2hpY2ggcnVucyBkdXJpbmcgZXhlY3V0aW9uLCBhZnRlciB2YWxpZGF0aW9uLlxuLy8gQWxsIG9mIHRoZXNlIGFyZSByZXR1cm5lZCB0byB0aGUgY2FsbGVyIGFuZCBkaXNjbG9zZSBzY2hlbWEgaWRlbnRpZmllcnMgKENsb3VkXG4vLyBDb2RlIGZ1bmN0aW9uIG5hbWVzLCBjbGFzcyBhbmQgZmllbGQgbmFtZXMpIHRoYXQgdGhlIGludHJvc3BlY3Rpb24gZ3VhcmQgaXNcbi8vIG1lYW50IHRvIGhpZGUuIFN0cmlwIHRoZSBoaW50IHN1ZmZpeCBmcm9tIGV2ZXJ5IHJldHVybmVkIGVycm9yIOKAlCBpbmNsdWRpbmcgdGhlXG4vLyBjb3B5IGdyYXBocWwtanMgZHVwbGljYXRlcyBpbnRvIGV4dGVuc2lvbnMuc3RhY2t0cmFjZSBpbiBub24tcHJvZHVjdGlvbiDigJQgZm9yXG4vLyBjYWxsZXJzIHRoYXQgYXJlIG5vdCBhbGxvd2VkIHRvIGludHJvc3BlY3QuXG5jb25zdCBzdHJpcFNjaGVtYVN1Z2dlc3Rpb24gPSBtZXNzYWdlID0+XG4gIHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJyA/IG1lc3NhZ2UucmVwbGFjZSgvID9EaWQgeW91IG1lYW4oLis/KVxcPyQvLCAnJykgOiBtZXNzYWdlO1xuXG4vLyBncmFwaHFsLWpzIGFsc28gZW1pdHMgYSBiYXNlIGlucHV0LWNvZXJjaW9uIG1lc3NhZ2UgdGhhdCBuYW1lcyBhIHNjaGVtYVxuLy8gaWRlbnRpZmllciBXSVRIT1VUIGEgXCJEaWQgeW91IG1lYW5cIiBjbGF1c2UsIHNvIHRoZSBzdWdnZXN0aW9uIHN0cmlwIGFib3ZlXG4vLyBjYW5ub3QgcmVhY2ggaXQ6IHdoZW4gYSByZXF1aXJlZCBjdXN0b20gaW5wdXQgZmllbGQgaXMgb21pdHRlZCwgY29lcmNlSW5wdXRWYWx1ZVxuLy8gcmV0dXJucyAnRmllbGQgXCI8bmFtZT5cIiBvZiByZXF1aXJlZCB0eXBlIFwiPHR5cGU+XCIgd2FzIG5vdCBwcm92aWRlZC4nLCBkaXNjbG9zaW5nXG4vLyBhIGZpZWxkIG5hbWUgdGhlIGNhbGxlciBuZXZlciBzdXBwbGllZC4gUmVkYWN0IHRoZSBxdW90ZWQgaWRlbnRpZmllcnMgZnJvbSB0aGlzXG4vLyB0ZW1wbGF0ZSB3aGlsZSBwcmVzZXJ2aW5nIHRoZSBlcnJvciBzaGFwZSwgZm9yIGNhbGxlcnMgdGhhdCBhcmUgbm90IGFsbG93ZWQgdG9cbi8vIGludHJvc3BlY3QuIFRoZSBzaWJsaW5nIGNvZXJjaW9uIG1lc3NhZ2VzICgnLi4uIGlzIG5vdCBkZWZpbmVkIGJ5IHR5cGUgXCI8dHlwZT5cIi4nLFxuLy8gJ0V4cGVjdGVkIHR5cGUgXCI8dHlwZT5cIiB0byBiZSBhbiBvYmplY3QuJykgYXJlIGludGVudGlvbmFsbHkgbGVmdCBpbnRhY3Q6IHRoZXlcbi8vIG9ubHkgZWNobyBhbiBpbnB1dCB0eXBlIG5hbWUgdGhlIGNhbGxlciBhbHJlYWR5IHJlZmVyZW5jZWQgaW4gdGhlIG9wZXJhdGlvbiwgc29cbi8vIHRoZXkgZGlzY2xvc2Ugbm90aGluZyB0aGUgY2FsbGVyIGRpZCBub3QgYWxyZWFkeSBwcm92aWRlLlxuY29uc3Qgc3RyaXBTY2hlbWFDb2VyY2lvbklkZW50aWZpZXJzID0gbWVzc2FnZSA9PlxuICB0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZydcbiAgICA/IG1lc3NhZ2UucmVwbGFjZShcbiAgICAgIC9GaWVsZCBcIlteXCJdKlwiIG9mIHJlcXVpcmVkIHR5cGUgXCJbXlwiXSpcIiB3YXMgbm90IHByb3ZpZGVkXFwuL2csXG4gICAgICAnRmllbGQgb2YgcmVxdWlyZWQgdHlwZSB3YXMgbm90IHByb3ZpZGVkLidcbiAgICApXG4gICAgOiBtZXNzYWdlO1xuXG4vLyBncmFwaHFsLWpzIGFsc28gZW1pdHMgYmFzZSBjb2VyY2lvbiAvIHZhbGlkYXRpb24gbWVzc2FnZXMgdGhhdCBuYW1lIGEgbmVzdGVkIGlucHV0XG4vLyBUWVBFIHdpdGhvdXQgYSBcIkRpZCB5b3UgbWVhblwiIGNsYXVzZSwgc28gbmVpdGhlciBzdHJpcCBhYm92ZSByZWFjaGVzIHRoZW0uIEZvciBhXG4vLyBQb2ludGVyIG9yIFJlbGF0aW9uIGZpZWxkIHRoZSBnZW5lcmF0ZWQgaW5wdXQgdHlwZSBuYW1lIGVtYmVkcyB0aGUgcG9pbnRlcidzIFRBUkdFVFxuLy8gY2xhc3MgKGA8VGFyZ2V0PlBvaW50ZXJJbnB1dGAsIGA8VGFyZ2V0PlJlbGF0aW9uV2hlcmVJbnB1dGAsIGBDcmVhdGU8VGFyZ2V0PkZpZWxkc0lucHV0YClcbi8vIOKAlCBhIGNsYXNzIHRoZSBjYWxsZXIgbmV2ZXIgcmVmZXJlbmNlZCBhbmQgY2Fubm90IGRlcml2ZSBmcm9tIHRoZSBmaWVsZCBuYW1lIHRoZXlcbi8vIHN1cHBsaWVkIOKAlCBzbyB0aGVzZSB0ZW1wbGF0ZXMgZGlzY2xvc2UgYSBzY2hlbWEgY2xhc3MgbmFtZSB0byBhIGNhbGxlciB3aG8gaGFzIG9ubHkgdGhlXG4vLyBwdWJsaWMgYXBwbGljYXRpb24gaWQuIFJlZGFjdCB0aGUgcXVvdGVkIHR5cGUgaWRlbnRpZmllciBmcm9tIHRob3NlIHRlbXBsYXRlcyBVTkxFU1MgdGhlXG4vLyBjYWxsZXIgcmVmZXJlbmNlZCBpdCBpbiB0aGUgb3BlcmF0aW9uIHRleHQ6IGEgdHlwZSBuYW1lIHRoZSBjYWxsZXIgd3JvdGUgaW4gdGhlIG9wZXJhdGlvblxuLy8gKGUuZy4gYCR3aGVyZTogVXNlcldoZXJlSW5wdXRgKSBpcyBub3QgYSBkaXNjbG9zdXJlLCBhbmQgcHJlc2VydmluZyBpdCBrZWVwcyB0aGUgbWVzc2FnZVxuLy8gKCcuLi4gaXMgbm90IGRlZmluZWQgYnkgdHlwZSBcIlVzZXJXaGVyZUlucHV0XCIuJykgdXNlZnVsLiBXaGVuIHRoZSBvcGVyYXRpb24gdGV4dCBpc1xuLy8gdW5hdmFpbGFibGUgdGhlIGlkZW50aWZpZXIgaXMgcmVkYWN0ZWQgKGZhaWwgY2xvc2VkKS5cbmNvbnN0IHN0cmlwU2NoZW1hVHlwZUlkZW50aWZpZXJzID0gKG1lc3NhZ2UsIG9wZXJhdGlvblRleHQpID0+IHtcbiAgaWYgKHR5cGVvZiBtZXNzYWdlICE9PSAnc3RyaW5nJykgeyByZXR1cm4gbWVzc2FnZTsgfVxuICAvLyBBIGdlbmVyYXRlZCB0eXBlIGlkZW50aWZpZXIgY291bnRzIGFzIFwicmVmZXJlbmNlZFwiIChhbmQgdGhlcmVmb3JlIG5vdCBhIGRpc2Nsb3N1cmUpIG9ubHkgaWZcbiAgLy8gdGhlIGNhbGxlciB3cm90ZSBpdCBhcyBhIHdob2xlIHRva2VuIGluIHRoZSBvcGVyYXRpb24gdGV4dC4gVG9rZW5pemUgdGhlIG9wZXJhdGlvbiBvblxuICAvLyBub24taWRlbnRpZmllciBjaGFyYWN0ZXJzIGFuZCBjb21wYXJlIGV4YWN0IHRva2VucyByYXRoZXIgdGhhbiBidWlsZGluZyBhIFJlZ0V4cCBmcm9tIHRoZVxuICAvLyBjYXB0dXJlZCBuYW1lOiB0aGlzIGF2b2lkcyBzdWJzdHJpbmcgZmFsc2UtbWF0Y2hlcyAoZS5nLiBwcmVzZXJ2aW5nIFwiQXV0aG9yUG9pbnRlcklucHV0XCJcbiAgLy8gYmVjYXVzZSB0aGUgb3BlcmF0aW9uIGNvbnRhaW5zIFwiU2VjcmV0QXV0aG9yUG9pbnRlcklucHV0XCIpIGFuZCBhbnkgcmVnZXggaW5qZWN0aW9uL1JlRG9TIGZyb21cbiAgLy8gYW4gdW51c3VhbCBjYXB0dXJlZCBuYW1lLiBHcmFwaFFMIGxpc3Qvbm9uLW51bGwgd3JhcHBlcnMgKFwiW1wiLCBcIl1cIiwgXCIhXCIpIGFyZSBzdHJpcHBlZCBmcm9tIHRoZVxuICAvLyBjYXB0dXJlZCBuYW1lIHNvIGUuZy4gXCJTZWNyZXRBdXRob3JQb2ludGVySW5wdXQhXCIgc3RpbGwgbWF0Y2hlcyBcIiR4OiBTZWNyZXRBdXRob3JQb2ludGVySW5wdXQhXCIuXG4gIC8vIFdoZW4gdGhlIG9wZXJhdGlvbiB0ZXh0IGlzIHVuYXZhaWxhYmxlIHRoZSB0eXBlIGlzIHRyZWF0ZWQgYXMgbm90IHJlZmVyZW5jZWQgKGZhaWwgY2xvc2VkKS5cbiAgY29uc3QgcmVmZXJlbmNlZFRva2VucyA9XG4gICAgdHlwZW9mIG9wZXJhdGlvblRleHQgPT09ICdzdHJpbmcnXG4gICAgICA/IG5ldyBTZXQob3BlcmF0aW9uVGV4dC5zcGxpdCgvW15fQS1aYS16MC05XSsvKS5maWx0ZXIoQm9vbGVhbikpXG4gICAgICA6IG5ldyBTZXQoKTtcbiAgY29uc3QgaXNSZWZlcmVuY2VkID0gdHlwZU5hbWUgPT4gcmVmZXJlbmNlZFRva2Vucy5oYXModHlwZU5hbWUucmVwbGFjZSgvW1tcXF0hXS9nLCAnJykpO1xuICByZXR1cm4gbWVzc2FnZVxuICAgIC8vIElucHV0IGNvZXJjaW9uIC8gVmFsdWVzT2ZDb3JyZWN0VHlwZVJ1bGUgKHZhcmlhYmxlcyBhbmQgaW5saW5lIGxpdGVyYWxzKS5cbiAgICAucmVwbGFjZSgvRXhwZWN0ZWQgdmFsdWUgb2YgdHlwZSBcIihbXlwiXSspXCIvZywgKG1hdGNoLCB0eXBlTmFtZSkgPT5cbiAgICAgIGlzUmVmZXJlbmNlZCh0eXBlTmFtZSkgPyBtYXRjaCA6ICdFeHBlY3RlZCB2YWx1ZSBvZiB0aGUgY29ycmVjdCB0eXBlJ1xuICAgIClcbiAgICAucmVwbGFjZSgvRXhwZWN0ZWQgdHlwZSBcIihbXlwiXSspXCIgdG8gYmUgYW4gb2JqZWN0XFwuL2csIChtYXRjaCwgdHlwZU5hbWUpID0+XG4gICAgICBpc1JlZmVyZW5jZWQodHlwZU5hbWUpID8gbWF0Y2ggOiAnRXhwZWN0ZWQgYW4gb2JqZWN0LidcbiAgICApXG4gICAgLnJlcGxhY2UoL0V4cGVjdGVkIG5vbi1udWxsYWJsZSB0eXBlIFwiKFteXCJdKylcIiBub3QgdG8gYmUgbnVsbFxcLi9nLCAobWF0Y2gsIHR5cGVOYW1lKSA9PlxuICAgICAgaXNSZWZlcmVuY2VkKHR5cGVOYW1lKSA/IG1hdGNoIDogJ0V4cGVjdGVkIGEgbm9uLW51bGwgdmFsdWUuJ1xuICAgIClcbiAgICAucmVwbGFjZSgvIGlzIG5vdCBkZWZpbmVkIGJ5IHR5cGUgXCIoW15cIl0rKVwiXFwuL2csIChtYXRjaCwgdHlwZU5hbWUpID0+XG4gICAgICBpc1JlZmVyZW5jZWQodHlwZU5hbWUpID8gbWF0Y2ggOiAnIGlzIG5vdCBkZWZpbmVkLidcbiAgICApXG4gICAgLy8gVmFyaWFibGVzSW5BbGxvd2VkUG9zaXRpb25SdWxlOiB0aGUgcG9zaXRpb24gdHlwZSBpcyB0aGUgcG9pbnRlci9yZWxhdGlvbiB0YXJnZXRcbiAgICAvLyBpbnB1dCB0eXBlOyB0aGUgY2FsbGVyIG9ubHkgd3JvdGUgdGhlaXIgb3duIHZhcmlhYmxlJ3MgZGVjbGFyZWQgdHlwZS5cbiAgICAucmVwbGFjZSgvIHVzZWQgaW4gcG9zaXRpb24gZXhwZWN0aW5nIHR5cGUgXCIoW15cIl0rKVwiXFwuL2csIChtYXRjaCwgdHlwZU5hbWUpID0+XG4gICAgICBpc1JlZmVyZW5jZWQodHlwZU5hbWUpID8gbWF0Y2ggOiAnIHVzZWQgaW4gcG9zaXRpb24gZXhwZWN0aW5nIGEgZGlmZmVyZW50IHR5cGUuJ1xuICAgIClcbiAgICAvLyBGaWVsZHNPbkNvcnJlY3RUeXBlUnVsZTogZGVzY2VuZGluZyBpbnRvIGEgUG9pbnRlci9SZWxhdGlvbiBvdXRwdXQgZmllbGQgbmFtZXMgaXRzXG4gICAgLy8gdGFyZ2V0IG91dHB1dCBvYmplY3QgdHlwZS5cbiAgICAucmVwbGFjZSgvQ2Fubm90IHF1ZXJ5IGZpZWxkIChcIlteXCJdKlwiKSBvbiB0eXBlIFwiKFteXCJdKylcIlxcLi9nLCAobWF0Y2gsIGZpZWxkTmFtZSwgdHlwZU5hbWUpID0+XG4gICAgICBpc1JlZmVyZW5jZWQodHlwZU5hbWUpID8gbWF0Y2ggOiBgQ2Fubm90IHF1ZXJ5IGZpZWxkICR7ZmllbGROYW1lfS5gXG4gICAgKVxuICAgIC8vIFNjYWxhckxlYWZzUnVsZTogc2VsZWN0aW5nIGEgUG9pbnRlci9SZWxhdGlvbiBvdXRwdXQgZmllbGQgd2l0aCBubyBzdWItc2VsZWN0aW9uIG5hbWVzXG4gICAgLy8gaXRzIHRhcmdldCBvdXRwdXQgb2JqZWN0IHR5cGUuXG4gICAgLnJlcGxhY2UoXG4gICAgICAvRmllbGQgKFwiW15cIl0qXCIpIG9mIHR5cGUgXCIoW15cIl0rKVwiIG11c3QgaGF2ZSBhIHNlbGVjdGlvbiBvZiBzdWJmaWVsZHNcXC4vZyxcbiAgICAgIChtYXRjaCwgZmllbGROYW1lLCB0eXBlTmFtZSkgPT5cbiAgICAgICAgaXNSZWZlcmVuY2VkKHR5cGVOYW1lKSA/IG1hdGNoIDogYEZpZWxkICR7ZmllbGROYW1lfSBtdXN0IGhhdmUgYSBzZWxlY3Rpb24gb2Ygc3ViZmllbGRzLmBcbiAgICApXG4gICAgLy8gUG9zc2libGVGcmFnbWVudFNwcmVhZHNSdWxlOiBhbiBpbmxpbmUvbmFtZWQgZnJhZ21lbnQgb24gYW4gaW5jb21wYXRpYmxlIHR5cGUgaW5zaWRlIGFcbiAgICAvLyBQb2ludGVyL1JlbGF0aW9uIG91dHB1dCBmaWVsZCBuYW1lcyB0aGUgdGFyZ2V0IG91dHB1dCBvYmplY3QgdHlwZSAodGhlIHBhcmVudCB0eXBlKS5cbiAgICAvLyBSZWRhY3QgZWFjaCB0eXBlIHRva2VuIHRoZSBjYWxsZXIgZGlkIG5vdCByZWZlcmVuY2U7IHdoZW4gYm90aCBhcmUgcmVmZXJlbmNlZCB0aGVcbiAgICAvLyByZWNvbnN0cnVjdGlvbiBpcyBpZGVudGljYWwgdG8gdGhlIG9yaWdpbmFsIG1lc3NhZ2UuXG4gICAgLnJlcGxhY2UoXG4gICAgICAvb2JqZWN0cyBvZiB0eXBlIFwiKFteXCJdKylcIiBjYW4gbmV2ZXIgYmUgb2YgdHlwZSBcIihbXlwiXSspXCJcXC4vZyxcbiAgICAgIChtYXRjaCwgcGFyZW50VHlwZSwgZnJhZ1R5cGUpID0+IHtcbiAgICAgICAgY29uc3QgcGFyZW50ID0gaXNSZWZlcmVuY2VkKHBhcmVudFR5cGUpID8gYHR5cGUgXCIke3BhcmVudFR5cGV9XCJgIDogJ3RoZSBwYXJlbnQgdHlwZSc7XG4gICAgICAgIGNvbnN0IGZyYWcgPSBpc1JlZmVyZW5jZWQoZnJhZ1R5cGUpID8gYHR5cGUgXCIke2ZyYWdUeXBlfVwiYCA6ICd0aGUgZ2l2ZW4gdHlwZSc7XG4gICAgICAgIHJldHVybiBgb2JqZWN0cyBvZiAke3BhcmVudH0gY2FuIG5ldmVyIGJlIG9mICR7ZnJhZ30uYDtcbiAgICAgIH1cbiAgICApO1xufTtcblxuY29uc3Qgc3RyaXBTY2hlbWFJZGVudGlmaWVycyA9IChtZXNzYWdlLCBvcGVyYXRpb25UZXh0KSA9PlxuICBzdHJpcFNjaGVtYVR5cGVJZGVudGlmaWVycyhcbiAgICBzdHJpcFNjaGVtYUNvZXJjaW9uSWRlbnRpZmllcnMoc3RyaXBTY2hlbWFTdWdnZXN0aW9uKG1lc3NhZ2UpKSxcbiAgICBvcGVyYXRpb25UZXh0XG4gICk7XG5cbmNvbnN0IFNjaGVtYVN1Z2dlc3Rpb25zQ29udHJvbFBsdWdpbiA9IChwdWJsaWNJbnRyb3NwZWN0aW9uKSA9PiAoe1xuICByZXF1ZXN0RGlkU3RhcnQ6IGFzeW5jIChyZXF1ZXN0Q29udGV4dCkgPT4gKHtcbiAgICB3aWxsU2VuZFJlc3BvbnNlOiBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAocHVibGljSW50cm9zcGVjdGlvbikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCBpc01hc3Rlck9yTWFpbnRlbmFuY2UgPVxuICAgICAgICByZXF1ZXN0Q29udGV4dC5jb250ZXh0VmFsdWUuYXV0aD8uaXNNYXN0ZXIgfHxcbiAgICAgICAgcmVxdWVzdENvbnRleHQuY29udGV4dFZhbHVlLmF1dGg/LmlzTWFpbnRlbmFuY2U7XG4gICAgICBpZiAoaXNNYXN0ZXJPck1haW50ZW5hbmNlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGJvZHkgPSByZXF1ZXN0Q29udGV4dC5yZXNwb25zZT8uYm9keTtcbiAgICAgIGNvbnN0IGVycm9ycyA9XG4gICAgICAgIGJvZHk/LmtpbmQgPT09ICdzaW5nbGUnXG4gICAgICAgICAgPyBib2R5LnNpbmdsZVJlc3VsdC5lcnJvcnNcbiAgICAgICAgICA6IGJvZHk/LmtpbmQgPT09ICdpbmNyZW1lbnRhbCdcbiAgICAgICAgICAgID8gYm9keS5pbml0aWFsUmVzdWx0LmVycm9yc1xuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBvcGVyYXRpb25UZXh0ID0gcmVxdWVzdENvbnRleHQucmVxdWVzdD8ucXVlcnk7XG4gICAgICBlcnJvcnM/LmZvckVhY2goZXJyb3IgPT4ge1xuICAgICAgICBlcnJvci5tZXNzYWdlID0gc3RyaXBTY2hlbWFJZGVudGlmaWVycyhlcnJvci5tZXNzYWdlLCBvcGVyYXRpb25UZXh0KTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZXJyb3IuZXh0ZW5zaW9ucz8uc3RhY2t0cmFjZSkpIHtcbiAgICAgICAgICBlcnJvci5leHRlbnNpb25zLnN0YWNrdHJhY2UgPSBlcnJvci5leHRlbnNpb25zLnN0YWNrdHJhY2UubWFwKG1lc3NhZ2UgPT5cbiAgICAgICAgICAgIHN0cmlwU2NoZW1hSWRlbnRpZmllcnMobWVzc2FnZSwgb3BlcmF0aW9uVGV4dClcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9LFxuICB9KSxcbn0pO1xuXG5jbGFzcyBQYXJzZUdyYXBoUUxTZXJ2ZXIge1xuICBwYXJzZUdyYXBoUUxDb250cm9sbGVyOiBQYXJzZUdyYXBoUUxDb250cm9sbGVyO1xuXG4gIGNvbnN0cnVjdG9yKHBhcnNlU2VydmVyLCBjb25maWcpIHtcbiAgICB0aGlzLnBhcnNlU2VydmVyID0gcGFyc2VTZXJ2ZXIgfHwgcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYSBwYXJzZVNlcnZlciBpbnN0YW5jZSEnKTtcbiAgICBpZiAoIWNvbmZpZyB8fCAhY29uZmlnLmdyYXBoUUxQYXRoKSB7XG4gICAgICByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIGNvbmZpZy5ncmFwaFFMUGF0aCEnKTtcbiAgICB9XG4gICAgdGhpcy5jb25maWcgPSBjb25maWc7XG4gICAgdGhpcy5wYXJzZUdyYXBoUUxDb250cm9sbGVyID0gdGhpcy5wYXJzZVNlcnZlci5jb25maWcucGFyc2VHcmFwaFFMQ29udHJvbGxlcjtcbiAgICB0aGlzLmxvZyA9XG4gICAgICAodGhpcy5wYXJzZVNlcnZlci5jb25maWcgJiYgdGhpcy5wYXJzZVNlcnZlci5jb25maWcubG9nZ2VyQ29udHJvbGxlcikgfHwgZGVmYXVsdExvZ2dlcjtcbiAgICB0aGlzLnBhcnNlR3JhcGhRTFNjaGVtYSA9IG5ldyBQYXJzZUdyYXBoUUxTY2hlbWEoe1xuICAgICAgcGFyc2VHcmFwaFFMQ29udHJvbGxlcjogdGhpcy5wYXJzZUdyYXBoUUxDb250cm9sbGVyLFxuICAgICAgZGF0YWJhc2VDb250cm9sbGVyOiB0aGlzLnBhcnNlU2VydmVyLmNvbmZpZy5kYXRhYmFzZUNvbnRyb2xsZXIsXG4gICAgICBsb2c6IHRoaXMubG9nLFxuICAgICAgZ3JhcGhRTEN1c3RvbVR5cGVEZWZzOiB0aGlzLmNvbmZpZy5ncmFwaFFMQ3VzdG9tVHlwZURlZnMsXG4gICAgICBhcHBJZDogdGhpcy5wYXJzZVNlcnZlci5jb25maWcuYXBwSWQsXG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBfZ2V0R3JhcGhRTE9wdGlvbnMoKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHNjaGVtYTogYXdhaXQgdGhpcy5wYXJzZUdyYXBoUUxTY2hlbWEubG9hZCgpLFxuICAgICAgICBjb250ZXh0OiBhc3luYyAoeyByZXEgfSkgPT4ge1xuICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBpbmZvOiByZXEuaW5mbyxcbiAgICAgICAgICAgIGNvbmZpZzogcmVxLmNvbmZpZyxcbiAgICAgICAgICAgIGF1dGg6IHJlcS5hdXRoLFxuICAgICAgICAgIH07XG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRoaXMubG9nLmVycm9yKGUuc3RhY2sgfHwgKHR5cGVvZiBlLnRvU3RyaW5nID09PSAnZnVuY3Rpb24nICYmIGUudG9TdHJpbmcoKSkgfHwgZSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIF9nZXRTZXJ2ZXIoKSB7XG4gICAgY29uc3Qgc2NoZW1hUmVmID0gdGhpcy5wYXJzZUdyYXBoUUxTY2hlbWEuZ3JhcGhRTFNjaGVtYTtcbiAgICBjb25zdCBuZXdTY2hlbWFSZWYgPSBhd2FpdCB0aGlzLnBhcnNlR3JhcGhRTFNjaGVtYS5sb2FkKCk7XG4gICAgaWYgKHNjaGVtYVJlZiA9PT0gbmV3U2NoZW1hUmVmICYmIHRoaXMuX3NlcnZlcikge1xuICAgICAgcmV0dXJuIHRoaXMuX3NlcnZlcjtcbiAgICB9XG4gICAgLy8gSXQgbWVhbnMgYSBwYXJhbGxlbCBfZ2V0U2VydmVyIGNhbGwgaXMgYWxyZWFkeSBpbiBwcm9ncmVzc1xuICAgIGlmICh0aGlzLl9zY2hlbWFSZWZNdXRleCA9PT0gbmV3U2NoZW1hUmVmKSB7XG4gICAgICByZXR1cm4gdGhpcy5fc2VydmVyO1xuICAgIH1cbiAgICAvLyBVcGRhdGUgdGhlIHNjaGVtYSByZWYgbXV0ZXggdG8gYXZvaWQgcGFyYWxsZWwgX2dldFNlcnZlciBjYWxsc1xuICAgIHRoaXMuX3NjaGVtYVJlZk11dGV4ID0gbmV3U2NoZW1hUmVmO1xuICAgIGNvbnN0IGNyZWF0ZVNlcnZlciA9IGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgc2NoZW1hLCBjb250ZXh0IH0gPSBhd2FpdCB0aGlzLl9nZXRHcmFwaFFMT3B0aW9ucygpO1xuICAgICAgICBjb25zdCBhcG9sbG8gPSBuZXcgQXBvbGxvU2VydmVyKHtcbiAgICAgICAgICBjc3JmUHJldmVudGlvbjoge1xuICAgICAgICAgICAgLy8gU2VlIGh0dHBzOi8vd3d3LmFwb2xsb2dyYXBocWwuY29tL2RvY3Mvcm91dGVyL2NvbmZpZ3VyYXRpb24vY3NyZi9cbiAgICAgICAgICAgIC8vIG5lZWRlZCBzaW5jZSB3ZSB1c2UgZ3JhcGhxbCB1cGxvYWRcbiAgICAgICAgICAgIHJlcXVlc3RIZWFkZXJzOiBbJ1gtUGFyc2UtQXBwbGljYXRpb24tSWQnXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIC8vIFdlIG5lZWQgYWx3YXlzIHRydWUgaW50cm9zcGVjdGlvbiBiZWNhdXNlIGFwb2xsbyBzZXJ2ZXIgaGF2ZSBjaGFuZ2luZyBiZWhhdmlvciBiYXNlZCBvbiB0aGUgTk9ERV9FTlYgdmFyaWFibGVcbiAgICAgICAgICAvLyB3ZSBkZWxlZ2F0ZSB0aGUgaW50cm9zcGVjdGlvbiBjb250cm9sIHRvIHRoZSBJbnRyb3NwZWN0aW9uQ29udHJvbFBsdWdpblxuICAgICAgICAgIGludHJvc3BlY3Rpb246IHRydWUsXG4gICAgICAgICAgcGx1Z2luczogW0Fwb2xsb1NlcnZlclBsdWdpbkNhY2hlQ29udHJvbERpc2FibGVkKCksIEludHJvc3BlY3Rpb25Db250cm9sUGx1Z2luKHRoaXMuY29uZmlnLmdyYXBoUUxQdWJsaWNJbnRyb3NwZWN0aW9uKSwgU2NoZW1hU3VnZ2VzdGlvbnNDb250cm9sUGx1Z2luKHRoaXMuY29uZmlnLmdyYXBoUUxQdWJsaWNJbnRyb3NwZWN0aW9uKSwgY3JlYXRlQ29tcGxleGl0eVZhbGlkYXRpb25QbHVnaW4oKCkgPT4gdGhpcy5wYXJzZVNlcnZlci5jb25maWcucmVxdWVzdENvbXBsZXhpdHkpXSxcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhcG9sbG8uc3RhcnQoKTtcbiAgICAgICAgcmV0dXJuIGV4cHJlc3NNaWRkbGV3YXJlKGFwb2xsbywge1xuICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBSZXNldCBhbGwgbXV0ZXhlcyBhbmQgZm9yd2FyZCB0aGUgZXJyb3JcbiAgICAgICAgdGhpcy5fc2VydmVyID0gbnVsbDtcbiAgICAgICAgdGhpcy5fc2NoZW1hUmVmTXV0ZXggPSBudWxsO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBEbyBub3QgYXdhaXQgc28gcGFyYWxsZWwgcmVxdWVzdCB3aWxsIHdhaXQgdGhlIHNhbWUgcHJvbWlzZSByZWZcbiAgICB0aGlzLl9zZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKTtcbiAgICByZXR1cm4gdGhpcy5fc2VydmVyO1xuICB9XG5cbiAgX3RyYW5zZm9ybU1heFVwbG9hZFNpemVUb0J5dGVzKG1heFVwbG9hZFNpemUpIHtcbiAgICBjb25zdCB1bml0TWFwID0ge1xuICAgICAga2I6IDEsXG4gICAgICBtYjogMixcbiAgICAgIGdiOiAzLFxuICAgIH07XG5cbiAgICByZXR1cm4gKFxuICAgICAgTnVtYmVyKG1heFVwbG9hZFNpemUuc2xpY2UoMCwgLTIpKSAqXG4gICAgICBNYXRoLnBvdygxMDI0LCB1bml0TWFwW21heFVwbG9hZFNpemUuc2xpY2UoLTIpLnRvTG93ZXJDYXNlKCldKVxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQHN0YXRpY1xuICAgKiBBbGxvdyBkZXZlbG9wZXJzIHRvIGN1c3RvbWl6ZSBlYWNoIHJlcXVlc3Qgd2l0aCBpbnZlcnNpb24gb2YgY29udHJvbC9kZXBlbmRlbmN5IGluamVjdGlvblxuICAgKi9cbiAgYXBwbHlSZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUoYXBpLCBvcHRpb25zKSB7XG4gICAgaWYgKG9wdGlvbnMucmVxdWVzdENvbnRleHRNaWRkbGV3YXJlKSB7XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbnMucmVxdWVzdENvbnRleHRNaWRkbGV3YXJlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigncmVxdWVzdENvbnRleHRNaWRkbGV3YXJlIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICAgICAgfVxuICAgICAgYXBpLnVzZSh0aGlzLmNvbmZpZy5ncmFwaFFMUGF0aCwgb3B0aW9ucy5yZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUpO1xuICAgIH1cbiAgfVxuXG4gIGFwcGx5R3JhcGhRTChhcHApIHtcbiAgICBpZiAoIWFwcCB8fCAhYXBwLnVzZSkge1xuICAgICAgcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYW4gRXhwcmVzcy5qcyBhcHAgaW5zdGFuY2UhJyk7XG4gICAgfVxuICAgIGFwcC51c2UodGhpcy5jb25maWcuZ3JhcGhRTFBhdGgsIGFsbG93Q3Jvc3NEb21haW4odGhpcy5wYXJzZVNlcnZlci5jb25maWcuYXBwSWQpKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBoYW5kbGVQYXJzZUhlYWRlcnMpO1xuICAgIGFwcC51c2UodGhpcy5jb25maWcuZ3JhcGhRTFBhdGgsIGhhbmRsZVBhcnNlU2Vzc2lvbik7XG4gICAgdGhpcy5hcHBseVJlcXVlc3RDb250ZXh0TWlkZGxld2FyZShhcHAsIHRoaXMucGFyc2VTZXJ2ZXIuY29uZmlnKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBoYW5kbGVQYXJzZUVycm9ycyk7XG4gICAgYXBwLnVzZShcbiAgICAgIHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLFxuICAgICAgZ3JhcGhxbFVwbG9hZEV4cHJlc3Moe1xuICAgICAgICBtYXhGaWxlU2l6ZTogdGhpcy5fdHJhbnNmb3JtTWF4VXBsb2FkU2l6ZVRvQnl0ZXMoXG4gICAgICAgICAgdGhpcy5wYXJzZVNlcnZlci5jb25maWcubWF4VXBsb2FkU2l6ZSB8fCAnMjBtYidcbiAgICAgICAgKSxcbiAgICAgIH0pXG4gICAgKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBleHByZXNzLmpzb24oKSwgYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBhd2FpdCB0aGlzLl9nZXRTZXJ2ZXIoKTtcbiAgICAgIHJldHVybiBzZXJ2ZXIocmVxLCByZXMsIG5leHQpO1xuICAgIH0pO1xuICB9XG5cbiAgYXBwbHlQbGF5Z3JvdW5kKGFwcCkge1xuICAgIGlmICghYXBwIHx8ICFhcHAuZ2V0KSB7XG4gICAgICByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhbiBFeHByZXNzLmpzIGFwcCBpbnN0YW5jZSEnKTtcbiAgICB9XG5cbiAgICBhcHAuZ2V0KFxuICAgICAgdGhpcy5jb25maWcucGxheWdyb3VuZFBhdGggfHxcbiAgICAgIHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgY29uZmlnLnBsYXlncm91bmRQYXRoIHRvIGFwcGx5UGxheWdyb3VuZCEnKSxcbiAgICAgIChfcmVxLCByZXMpID0+IHtcbiAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ3RleHQvaHRtbCcpO1xuICAgICAgICByZXMud3JpdGUoXG4gICAgICAgICAgYDxkaXYgaWQ9XCJzYW5kYm94XCIgc3R5bGU9XCJwb3NpdGlvbjphYnNvbHV0ZTt0b3A6MDtyaWdodDowO2JvdHRvbTowO2xlZnQ6MFwiPjwvZGl2PlxuICAgICAgICAgIDxzY3JpcHQgc3JjPVwiaHR0cHM6Ly9lbWJlZGRhYmxlLXNhbmRib3guY2RuLmFwb2xsb2dyYXBocWwuY29tL19sYXRlc3QvZW1iZWRkYWJsZS1zYW5kYm94LnVtZC5wcm9kdWN0aW9uLm1pbi5qc1wiPjwvc2NyaXB0PlxuICAgICAgICAgIDxzY3JpcHQ+XG4gICAgICAgICAgIG5ldyB3aW5kb3cuRW1iZWRkZWRTYW5kYm94KHtcbiAgICAgICAgICAgICB0YXJnZXQ6IFwiI3NhbmRib3hcIixcbiAgICAgICAgICAgICBlbmRwb2ludElzRWRpdGFibGU6IGZhbHNlLFxuICAgICAgICAgICAgIGluaXRpYWxFbmRwb2ludDogJHtKU09OLnN0cmluZ2lmeSh0aGlzLmNvbmZpZy5ncmFwaFFMUGF0aCl9LFxuICAgICAgICAgICAgIGhhbmRsZVJlcXVlc3Q6IChlbmRwb2ludFVybCwgb3B0aW9ucykgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZmV0Y2goZW5kcG9pbnRVcmwsIHtcbiAgICAgICAgICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgLi4ub3B0aW9ucy5oZWFkZXJzLFxuICAgICAgICAgICAgICAgICAgICAnWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCc6ICR7SlNPTi5zdHJpbmdpZnkodGhpcy5wYXJzZVNlcnZlci5jb25maWcuYXBwSWQpfSxcbiAgICAgICAgICAgICAgICAgICAgJ1gtUGFyc2UtTWFzdGVyLUtleSc6ICR7SlNPTi5zdHJpbmdpZnkodGhpcy5wYXJzZVNlcnZlci5jb25maWcubWFzdGVyS2V5KX0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgIH0pO1xuICAgICAgICAgICAvLyBhZHZhbmNlZCBvcHRpb25zOiBodHRwczovL3d3dy5hcG9sbG9ncmFwaHFsLmNvbS9kb2NzL3N0dWRpby9leHBsb3Jlci9zYW5kYm94I2VtYmVkZGluZy1zYW5kYm94XG4gICAgICAgICAgPC9zY3JpcHQ+YFxuICAgICAgICApO1xuICAgICAgICByZXMuZW5kKCk7XG4gICAgICB9XG4gICAgKTtcbiAgfVxuXG4gIHNldEdyYXBoUUxDb25maWcoZ3JhcGhRTENvbmZpZzogUGFyc2VHcmFwaFFMQ29uZmlnKTogUHJvbWlzZSB7XG4gICAgcmV0dXJuIHRoaXMucGFyc2VHcmFwaFFMQ29udHJvbGxlci51cGRhdGVHcmFwaFFMQ29uZmlnKGdyYXBoUUxDb25maWcpO1xuICB9XG59XG5cbmV4cG9ydCB7IFBhcnNlR3JhcGhRTFNlcnZlciB9O1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxxQkFBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRCxPQUFBO0FBQ0EsSUFBQUUsUUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsU0FBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksU0FBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssUUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0sWUFBQSxHQUFBTixPQUFBO0FBQ0EsSUFBQU8sa0JBQUEsR0FBQVIsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFRLE9BQUEsR0FBQVQsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFTLG1CQUFBLEdBQUFULE9BQUE7QUFDQSxJQUFBVSx1QkFBQSxHQUFBQyx1QkFBQSxDQUFBWCxPQUFBO0FBQ0EsSUFBQVksZ0JBQUEsR0FBQVosT0FBQTtBQUE2RSxTQUFBVyx3QkFBQUUsQ0FBQSxFQUFBQyxDQUFBLDZCQUFBQyxPQUFBLE1BQUFDLENBQUEsT0FBQUQsT0FBQSxJQUFBRSxDQUFBLE9BQUFGLE9BQUEsWUFBQUosdUJBQUEsWUFBQUEsQ0FBQUUsQ0FBQSxFQUFBQyxDQUFBLFNBQUFBLENBQUEsSUFBQUQsQ0FBQSxJQUFBQSxDQUFBLENBQUFLLFVBQUEsU0FBQUwsQ0FBQSxNQUFBTSxDQUFBLEVBQUFDLENBQUEsRUFBQUMsQ0FBQSxLQUFBQyxTQUFBLFFBQUFDLE9BQUEsRUFBQVYsQ0FBQSxpQkFBQUEsQ0FBQSx1QkFBQUEsQ0FBQSx5QkFBQUEsQ0FB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