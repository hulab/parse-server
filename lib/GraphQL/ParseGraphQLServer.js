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
var _defaultGraphQLTypes = require("./loaders/defaultGraphQLTypes");
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

      // Apollo resolves the operation text into `requestContext.source` before this hook
      // runs and guarantees it is set here. It is NOT the same as `request.query`: on an
      // automatic persisted query cache hit the text comes from the persisted-query cache
      // and `request.query` is never populated, so reading `request.query` would leave
      // nothing to inspect and silently skip both guards below. Apollo enables automatic
      // persisted queries by default, so that path is reachable on every deployment. Fall
      // back to `request.query` only for robustness, and fail closed when neither is a
      // string so that an operation which cannot be inspected is never allowed through.
      const query = requestContext.source ?? requestContext.request.query;

      // Fast path: simple string check for __schema
      // This avoids parsing the query in most cases
      // An operation text that is not a string cannot be inspected at all, so it is denied
      // for the same reason: this guard must never let an operation through uninspected.
      if (typeof query !== 'string' || query.includes('__schema')) {
        return throwIntrospectionError();
      }

      // Smart check for __type: only parse if the string is present
      // This avoids false positives (e.g., "__type" in strings or comments)
      // while still being efficient for the common case
      if (query.includes('__type') && hasTypeIntrospection(query)) {
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

// Type names that reveal nothing about THIS application's schema, so redacting them would cost
// message quality for no security gain. `RESERVED_GRAPHQL_TYPE_NAMES` covers the names the schema
// builder refuses to let a class generate, but Parse registers built-in types outside that list
// too. Of those, only an ENUM can reach the enum templates below, and the GraphQL layer defines
// exactly three enums: `CloudCodeFunction` (reserved), the per-class `<Class>Order` (the
// disclosure these templates exist to redact) and `ReadPreference`. Include the last one so that
// an invalid `options.readPreference` value still names its enum, just as `CloudCodeFunction`
// does — it is identical on every deployment and reachable from every generated find query.
const NON_DISCLOSING_TYPE_NAMES = new Set([..._ParseGraphQLSchema.RESERVED_GRAPHQL_TYPE_NAMES, _defaultGraphQLTypes.READ_PREFERENCE.name]);

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
  // A generated type identifier is kept (it is not a disclosure) if the caller wrote it as a
  // whole token in the operation text, or if it is a non-disclosing name (above). Tokenize the
  // operation on non-identifier characters and compare exact tokens rather than building a
  // RegExp from the captured name: this avoids substring false-matches (e.g. preserving
  // "AuthorPointerInput" because the operation contains "SecretAuthorPointerInput") and any
  // regex injection/ReDoS from an unusual captured name. GraphQL list/non-null wrappers ("[",
  // "]", "!") are stripped from the captured name so e.g. "SecretAuthorPointerInput!" still
  // matches "$x: SecretAuthorPointerInput!". When the operation text is unavailable the type is
  // treated as not referenced (fail closed).
  const referencedTokens = typeof operationText === 'string' ? new Set(operationText.split(/[^_A-Za-z0-9]+/).filter(Boolean)) : new Set();
  // A non-disclosing type name (`CloudCodeFunction`, `ReadPreference`, `Viewer`, `PageInfo`, the
  // built-in scalars, ...) is identical on every Parse Server deployment and cannot collide with
  // a user class, since `ParseGraphQLSchema` rejects class names that would produce one. Echoing
  // one therefore discloses nothing about THIS application's schema, so it is preserved like a
  // caller-referenced name and the message stays useful.
  const shouldKeepTypeName = typeName => {
    const bareTypeName = typeName.replace(/[[\]!]/g, '');
    return NON_DISCLOSING_TYPE_NAMES.has(bareTypeName) || referencedTokens.has(bareTypeName);
  };
  return message
  // Input coercion / ValuesOfCorrectTypeRule (variables and inline literals).
  .replace(/Expected value of type "([^"]+)"/g, (match, typeName) => shouldKeepTypeName(typeName) ? match : 'Expected value of the correct type').replace(/Expected type "([^"]+)" to be an object\./g, (match, typeName) => shouldKeepTypeName(typeName) ? match : 'Expected an object.').replace(/Expected non-nullable type "([^"]+)" not to be null\./g, (match, typeName) => shouldKeepTypeName(typeName) ? match : 'Expected a non-null value.').replace(/ is not defined by type "([^"]+)"\./g, (match, typeName) => shouldKeepTypeName(typeName) ? match : ' is not defined.')
  // VariablesInAllowedPositionRule: the position type is the pointer/relation target
  // input type; the caller only wrote their own variable's declared type.
  .replace(/ used in position expecting type "([^"]+)"\./g, (match, typeName) => shouldKeepTypeName(typeName) ? match : ' used in position expecting a different type.')
  // FieldsOnCorrectTypeRule: descending into a Pointer/Relation output field names its
  // target output object type.
  .replace(/Cannot query field ("[^"]*") on type "([^"]+)"\./g, (match, fieldName, typeName) => shouldKeepTypeName(typeName) ? match : `Cannot query field ${fieldName}.`)
  // ScalarLeafsRule: selecting a Pointer/Relation output field with no sub-selection names
  // its target output object type.
  .replace(/Field ("[^"]*") of type "([^"]+)" must have a selection of subfields\./g, (match, fieldName, typeName) => shouldKeepTypeName(typeName) ? match : `Field ${fieldName} must have a selection of subfields.`)
  // PossibleFragmentSpreadsRule: an inline/named fragment on an incompatible type inside a
  // Pointer/Relation output field names the target output object type (the parent type).
  // Redact each type token the caller did not reference; when both are referenced the
  // reconstruction is identical to the original message.
  .replace(/objects of type "([^"]+)" can never be of type "([^"]+)"\./g, (match, parentType, fragType) => {
    const parent = shouldKeepTypeName(parentType) ? `type "${parentType}"` : 'the parent type';
    const frag = shouldKeepTypeName(fragType) ? `type "${fragType}"` : 'the given type';
    return `objects of ${parent} can never be of ${frag}.`;
  })
  // KnownArgumentNamesRule: the argument's parent OUTPUT type. Inside a Pointer/Relation
  // sub-selection that parent is the TARGET class, whose output type is named exactly the
  // class name (`parseClassTypes.js`), so it discloses a class the caller never wrote — they
  // only supplied the pointer field name. The type is embedded in a dotted "<Type>.<field>"
  // token; keep the field name (the caller wrote it) and redact only the type half. Note the
  // directive form ('... on directive "@name".') carries no type and is left alone.
  .replace(/Unknown argument ("[^"]*") on field "([^".]+)\.([^".]+)"\./g, (match, argName, typeName, fieldName) => shouldKeepTypeName(typeName) ? match : `Unknown argument ${argName} on field "${fieldName}".`)
  // GraphQLEnumType.parseValue/parseLiteral: a Relation field's `order` argument is typed
  // `[<Target>Order!]` (`parseClassTypes.js`), so an invalid enum literal names the target
  // class. These messages come from the enum type itself rather than from a validation rule,
  // which is why the ValuesOfCorrectTypeRule templates above do not reach them. The offending
  // value is caller-supplied and is preserved; only the enum type name is redacted.
  .replace(/Value ("[^"]*") does not exist in "([^"]+)" enum\./g, (match, value, typeName) => shouldKeepTypeName(typeName) ? match : `Value ${value} does not exist in the enum.`)
  // Sibling branches of the same enum type, reached when the literal is not an enum value at
  // all ('cannot represent non-enum value: ...', 'cannot represent non-string value: ...',
  // 'cannot represent value: ...'). Same disclosure, same redaction.
  .replace(/Enum "([^"]+)" cannot represent /g, (match, typeName) => shouldKeepTypeName(typeName) ? match : 'Enum cannot represent ');
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
      // Same as in `IntrospectionControlPlugin`: `requestContext.source` carries the
      // operation text for every request, including an automatic persisted query cache hit
      // where `request.query` is undefined. Reading `request.query` alone would make the
      // allowlist below empty on those requests and redact type names the caller wrote
      // themselves.
      const operationText = requestContext.source ?? requestContext.request?.query;
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
        // A value passed to this GraphQL server takes precedence; otherwise use the Parse Server
        // option, where the option is documented and where the security check reads it.
        const publicIntrospection = this.config.graphQLPublicIntrospection ?? this.parseServer.config.graphQLPublicIntrospection;
        const apollo = new _server.ApolloServer({
          csrfPrevention: {
            // See https://www.apollographql.com/docs/router/configuration/csrf/
            // needed since we use graphql upload
            requestHeaders: ['X-Parse-Application-Id']
          },
          // We need always true introspection because apollo server have changing behavior based on the NODE_ENV variable
          // we delegate the introspection control to the IntrospectionControlPlugin
          introspection: true,
          plugins: [(0, _disabled.ApolloServerPluginCacheControlDisabled)(), IntrospectionControlPlugin(publicIntrospection), SchemaSuggestionsControlPlugin(publicIntrospection), (0, _queryComplexity.createComplexityValidationPlugin)(() => this.parseServer.config.requestComplexity)],
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
    app.use(this.config.graphQLPath, (req, _res, next) => {
      // Rate limit path for any URL variant of the endpoint
      req._graphQLPath = this.config.graphQLPath;
      next();
    });
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfZ3JhcGhxbFVwbG9hZEV4cHJlc3MiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9zZXJ2ZXIiLCJfZXhwcmVzcyIsIl9kaXNhYmxlZCIsIl9leHByZXNzMiIsIl9ncmFwaHFsIiwiX21pZGRsZXdhcmVzIiwiX3JlcXVpcmVkUGFyYW1ldGVyIiwiX2xvZ2dlciIsIl9QYXJzZUdyYXBoUUxTY2hlbWEiLCJfZGVmYXVsdEdyYXBoUUxUeXBlcyIsIl9QYXJzZUdyYXBoUUxDb250cm9sbGVyIiwiX2ludGVyb3BSZXF1aXJlV2lsZGNhcmQiLCJfcXVlcnlDb21wbGV4aXR5IiwiZSIsInQiLCJXZWFrTWFwIiwiciIsIm4iLCJfX2VzTW9kdWxlIiwibyIsImkiLCJmIiwiX19wcm90b19fIiwiZGVmYXVsdCIsImhhcyIsImdldCIsInNldCIsImhhc093blByb3BlcnR5IiwiY2FsbCIsIk9iamVjdCIsImRlZmluZVByb3BlcnR5IiwiZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yIiwiaGFzVHlwZUludHJvc3BlY3Rpb24iLCJxdWVyeSIsImFzdCIsInBhcnNlIiwiY2hlY2tTZWxlY3Rpb25zIiwic2VsZWN0aW9ucyIsInNlbGVjdGlvbiIsImtpbmQiLCJuYW1lIiwidmFsdWUiLCJhcmd1bWVudHMiLCJsZW5ndGgiLCJzZWxlY3Rpb25TZXQiLCJkZWZpbml0aW9uIiwiZGVmaW5pdGlvbnMiLCJ0aHJvd0ludHJvc3BlY3Rpb25FcnJvciIsIkdyYXBoUUxFcnJvciIsImV4dGVuc2lvbnMiLCJodHRwIiwic3RhdHVzIiwiSW50cm9zcGVjdGlvbkNvbnRyb2xQbHVnaW4iLCJwdWJsaWNJbnRyb3NwZWN0aW9uIiwicmVxdWVzdERpZFN0YXJ0IiwicmVxdWVzdENvbnRleHQiLCJkaWRSZXNvbHZlT3BlcmF0aW9uIiwiaXNNYXN0ZXJPck1haW50ZW5hbmNlIiwiY29udGV4dFZhbHVlIiwiYXV0aCIsImlzTWFzdGVyIiwiaXNNYWludGVuYW5jZSIsInNvdXJjZSIsInJlcXVlc3QiLCJpbmNsdWRlcyIsInN0cmlwU2NoZW1hU3VnZ2VzdGlvbiIsIm1lc3NhZ2UiLCJyZXBsYWNlIiwic3RyaXBTY2hlbWFDb2VyY2lvbklkZW50aWZpZXJzIiwiTk9OX0RJU0NMT1NJTkdfVFlQRV9OQU1FUyIsIlNldCIsIlJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUyIsIlJFQURfUFJFRkVSRU5DRSIsInN0cmlwU2NoZW1hVHlwZUlkZW50aWZpZXJzIiwib3BlcmF0aW9uVGV4dCIsInJlZmVyZW5jZWRUb2tlbnMiLCJzcGxpdCIsImZpbHRlciIsIkJvb2xlYW4iLCJzaG91bGRLZWVwVHlwZU5hbWUiLCJ0eXBlTmFtZSIsImJhcmVUeXBlTmFtZSIsIm1hdGNoIiwiZmllbGROYW1lIiwicGFyZW50VHlwZSIsImZyYWdUeXBlIiwicGFyZW50IiwiZnJhZyIsImFyZ05hbWUiLCJzdHJpcFNjaGVtYUlkZW50aWZpZXJzIiwiU2NoZW1hU3VnZ2VzdGlvbnNDb250cm9sUGx1Z2luIiwid2lsbFNlbmRSZXNwb25zZSIsImJvZHkiLCJyZXNwb25zZSIsImVycm9ycyIsInNpbmdsZVJlc3VsdCIsImluaXRpYWxSZXN1bHQiLCJ1bmRlZmluZWQiLCJmb3JFYWNoIiwiZXJyb3IiLCJBcnJheSIsImlzQXJyYXkiLCJzdGFja3RyYWNlIiwibWFwIiwiUGFyc2VHcmFwaFFMU2VydmVyIiwiY29uc3RydWN0b3IiLCJwYXJzZVNlcnZlciIsImNvbmZpZyIsInJlcXVpcmVkUGFyYW1ldGVyIiwiZ3JhcGhRTFBhdGgiLCJwYXJzZUdyYXBoUUxDb250cm9sbGVyIiwibG9nIiwibG9nZ2VyQ29udHJvbGxlciIsImRlZmF1bHRMb2dnZXIiLCJwYXJzZUdyYXBoUUxTY2hlbWEiLCJQYXJzZUdyYXBoUUxTY2hlbWEiLCJkYXRhYmFzZUNvbnRyb2xsZXIiLCJncmFwaFFMQ3VzdG9tVHlwZURlZnMiLCJhcHBJZCIsIl9nZXRHcmFwaFFMT3B0aW9ucyIsInNjaGVtYSIsImxvYWQiLCJjb250ZXh0IiwicmVxIiwiaW5mbyIsInN0YWNrIiwidG9TdHJpbmciLCJfZ2V0U2VydmVyIiwic2NoZW1hUmVmIiwiZ3JhcGhRTFNjaGVtYSIsIm5ld1NjaGVtYVJlZiIsIl9zY2hlbWFSZWZNdXRleCIsImNyZWF0ZVNlcnZlciIsImdyYXBoUUxQdWJsaWNJbnRyb3NwZWN0aW9uIiwiYXBvbGxvIiwiQXBvbGxvU2VydmVyIiwiY3NyZlByZXZlbnRpb24iLCJyZXF1ZXN0SGVhZGVycyIsImludHJvc3BlY3Rpb24iLCJwbHVnaW5zIiwiQXBvbGxvU2VydmVyUGx1Z2luQ2FjaGVDb250cm9sRGlzYWJsZWQiLCJjcmVhdGVDb21wbGV4aXR5VmFsaWRhdGlvblBsdWdpbiIsInJlcXVlc3RDb21wbGV4aXR5Iiwic3RhcnQiLCJleHByZXNzTWlkZGxld2FyZSIsIl90cmFuc2Zvcm1NYXhVcGxvYWRTaXplVG9CeXRlcyIsIm1heFVwbG9hZFNpemUiLCJ1bml0TWFwIiwia2IiLCJtYiIsImdiIiwiTnVtYmVyIiwic2xpY2UiLCJNYXRoIiwicG93IiwidG9Mb3dlckNhc2UiLCJhcHBseVJlcXVlc3RDb250ZXh0TWlkZGxld2FyZSIsImFwaSIsIm9wdGlvbnMiLCJyZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUiLCJFcnJvciIsInVzZSIsImFwcGx5R3JhcGhRTCIsImFwcCIsImFsbG93Q3Jvc3NEb21haW4iLCJfcmVzIiwibmV4dCIsIl9ncmFwaFFMUGF0aCIsImhhbmRsZVBhcnNlSGVhZGVycyIsImhhbmRsZVBhcnNlU2Vzc2lvbiIsImhhbmRsZVBhcnNlRXJyb3JzIiwiZ3JhcGhxbFVwbG9hZEV4cHJlc3MiLCJtYXhGaWxlU2l6ZSIsImV4cHJlc3MiLCJqc29uIiwicmVzIiwic2VydmVyIiwiYXBwbHlQbGF5Z3JvdW5kIiwicGxheWdyb3VuZFBhdGgiLCJfcmVxIiwic2V0SGVhZGVyIiwid3JpdGUiLCJKU09OIiwic3RyaW5naWZ5IiwibWFzdGVyS2V5IiwiZW5kIiwic2V0R3JhcGhRTENvbmZpZyIsImdyYXBoUUxDb25maWciLCJ1cGRhdGVHcmFwaFFMQ29uZmlnIiwiZXhwb3J0cyJdLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9HcmFwaFFML1BhcnNlR3JhcGhRTFNlcnZlci5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZ3JhcGhxbFVwbG9hZEV4cHJlc3MgZnJvbSAnZ3JhcGhxbC11cGxvYWQvZ3JhcGhxbFVwbG9hZEV4cHJlc3MuanMnO1xuaW1wb3J0IHsgQXBvbGxvU2VydmVyIH0gZnJvbSAnQGFwb2xsby9zZXJ2ZXInO1xuaW1wb3J0IHsgZXhwcmVzc01pZGRsZXdhcmUgfSBmcm9tICdAYXMtaW50ZWdyYXRpb25zL2V4cHJlc3M1JztcbmltcG9ydCB7IEFwb2xsb1NlcnZlclBsdWdpbkNhY2hlQ29udHJvbERpc2FibGVkIH0gZnJvbSAnQGFwb2xsby9zZXJ2ZXIvcGx1Z2luL2Rpc2FibGVkJztcbmltcG9ydCBleHByZXNzIGZyb20gJ2V4cHJlc3MnO1xuaW1wb3J0IHsgR3JhcGhRTEVycm9yLCBwYXJzZSB9IGZyb20gJ2dyYXBocWwnO1xuaW1wb3J0IHsgYWxsb3dDcm9zc0RvbWFpbiwgaGFuZGxlUGFyc2VFcnJvcnMsIGhhbmRsZVBhcnNlSGVhZGVycywgaGFuZGxlUGFyc2VTZXNzaW9uIH0gZnJvbSAnLi4vbWlkZGxld2FyZXMnO1xuaW1wb3J0IHJlcXVpcmVkUGFyYW1ldGVyIGZyb20gJy4uL3JlcXVpcmVkUGFyYW1ldGVyJztcbmltcG9ydCBkZWZhdWx0TG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgeyBQYXJzZUdyYXBoUUxTY2hlbWEsIFJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUyB9IGZyb20gJy4vUGFyc2VHcmFwaFFMU2NoZW1hJztcbmltcG9ydCB7IFJFQURfUFJFRkVSRU5DRSB9IGZyb20gJy4vbG9hZGVycy9kZWZhdWx0R3JhcGhRTFR5cGVzJztcbmltcG9ydCBQYXJzZUdyYXBoUUxDb250cm9sbGVyLCB7IFBhcnNlR3JhcGhRTENvbmZpZyB9IGZyb20gJy4uL0NvbnRyb2xsZXJzL1BhcnNlR3JhcGhRTENvbnRyb2xsZXInO1xuaW1wb3J0IHsgY3JlYXRlQ29tcGxleGl0eVZhbGlkYXRpb25QbHVnaW4gfSBmcm9tICcuL2hlbHBlcnMvcXVlcnlDb21wbGV4aXR5JztcblxuXG5jb25zdCBoYXNUeXBlSW50cm9zcGVjdGlvbiA9IChxdWVyeSkgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IGFzdCA9IHBhcnNlKHF1ZXJ5KTtcbiAgICBjb25zdCBjaGVja1NlbGVjdGlvbnMgPSAoc2VsZWN0aW9ucykgPT4ge1xuICAgICAgZm9yIChjb25zdCBzZWxlY3Rpb24gb2Ygc2VsZWN0aW9ucykge1xuICAgICAgICBpZiAoc2VsZWN0aW9uLmtpbmQgPT09ICdGaWVsZCcgJiYgc2VsZWN0aW9uLm5hbWUudmFsdWUgPT09ICdfX3R5cGUnKSB7XG4gICAgICAgICAgaWYgKHNlbGVjdGlvbi5hcmd1bWVudHMgJiYgc2VsZWN0aW9uLmFyZ3VtZW50cy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHNlbGVjdGlvbi5zZWxlY3Rpb25TZXQpIHtcbiAgICAgICAgICBpZiAoY2hlY2tTZWxlY3Rpb25zKHNlbGVjdGlvbi5zZWxlY3Rpb25TZXQuc2VsZWN0aW9ucykpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH07XG4gICAgZm9yIChjb25zdCBkZWZpbml0aW9uIG9mIGFzdC5kZWZpbml0aW9ucykge1xuICAgICAgaWYgKGRlZmluaXRpb24uc2VsZWN0aW9uU2V0KSB7XG4gICAgICAgIGlmIChjaGVja1NlbGVjdGlvbnMoZGVmaW5pdGlvbi5zZWxlY3Rpb25TZXQuc2VsZWN0aW9ucykpIHtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufTtcblxuY29uc3QgdGhyb3dJbnRyb3NwZWN0aW9uRXJyb3IgPSAoKSA9PiB7XG4gIHRocm93IG5ldyBHcmFwaFFMRXJyb3IoJ0ludHJvc3BlY3Rpb24gaXMgbm90IGFsbG93ZWQnLCB7XG4gICAgZXh0ZW5zaW9uczoge1xuICAgICAgaHR0cDoge1xuICAgICAgICBzdGF0dXM6IDQwMyxcbiAgICAgIH0sXG4gICAgfVxuICB9KTtcbn07XG5cbmNvbnN0IEludHJvc3BlY3Rpb25Db250cm9sUGx1Z2luID0gKHB1YmxpY0ludHJvc3BlY3Rpb24pID0+ICh7XG5cblxuICByZXF1ZXN0RGlkU3RhcnQ6IChyZXF1ZXN0Q29udGV4dCkgPT4gKHtcblxuICAgIGRpZFJlc29sdmVPcGVyYXRpb246IGFzeW5jICgpID0+IHtcbiAgICAgIC8vIElmIHB1YmxpYyBpbnRyb3NwZWN0aW9uIGlzIGVuYWJsZWQsIHdlIGFsbG93IGFsbCBpbnRyb3NwZWN0aW9uIHF1ZXJpZXNcbiAgICAgIGlmIChwdWJsaWNJbnRyb3NwZWN0aW9uKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaXNNYXN0ZXJPck1haW50ZW5hbmNlID0gcmVxdWVzdENvbnRleHQuY29udGV4dFZhbHVlLmF1dGg/LmlzTWFzdGVyIHx8IHJlcXVlc3RDb250ZXh0LmNvbnRleHRWYWx1ZS5hdXRoPy5pc01haW50ZW5hbmNlXG4gICAgICBpZiAoaXNNYXN0ZXJPck1haW50ZW5hbmNlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gQXBvbGxvIHJlc29sdmVzIHRoZSBvcGVyYXRpb24gdGV4dCBpbnRvIGByZXF1ZXN0Q29udGV4dC5zb3VyY2VgIGJlZm9yZSB0aGlzIGhvb2tcbiAgICAgIC8vIHJ1bnMgYW5kIGd1YXJhbnRlZXMgaXQgaXMgc2V0IGhlcmUuIEl0IGlzIE5PVCB0aGUgc2FtZSBhcyBgcmVxdWVzdC5xdWVyeWA6IG9uIGFuXG4gICAgICAvLyBhdXRvbWF0aWMgcGVyc2lzdGVkIHF1ZXJ5IGNhY2hlIGhpdCB0aGUgdGV4dCBjb21lcyBmcm9tIHRoZSBwZXJzaXN0ZWQtcXVlcnkgY2FjaGVcbiAgICAgIC8vIGFuZCBgcmVxdWVzdC5xdWVyeWAgaXMgbmV2ZXIgcG9wdWxhdGVkLCBzbyByZWFkaW5nIGByZXF1ZXN0LnF1ZXJ5YCB3b3VsZCBsZWF2ZVxuICAgICAgLy8gbm90aGluZyB0byBpbnNwZWN0IGFuZCBzaWxlbnRseSBza2lwIGJvdGggZ3VhcmRzIGJlbG93LiBBcG9sbG8gZW5hYmxlcyBhdXRvbWF0aWNcbiAgICAgIC8vIHBlcnNpc3RlZCBxdWVyaWVzIGJ5IGRlZmF1bHQsIHNvIHRoYXQgcGF0aCBpcyByZWFjaGFibGUgb24gZXZlcnkgZGVwbG95bWVudC4gRmFsbFxuICAgICAgLy8gYmFjayB0byBgcmVxdWVzdC5xdWVyeWAgb25seSBmb3Igcm9idXN0bmVzcywgYW5kIGZhaWwgY2xvc2VkIHdoZW4gbmVpdGhlciBpcyBhXG4gICAgICAvLyBzdHJpbmcgc28gdGhhdCBhbiBvcGVyYXRpb24gd2hpY2ggY2Fubm90IGJlIGluc3BlY3RlZCBpcyBuZXZlciBhbGxvd2VkIHRocm91Z2guXG4gICAgICBjb25zdCBxdWVyeSA9IHJlcXVlc3RDb250ZXh0LnNvdXJjZSA/PyByZXF1ZXN0Q29udGV4dC5yZXF1ZXN0LnF1ZXJ5O1xuXG4gICAgICAvLyBGYXN0IHBhdGg6IHNpbXBsZSBzdHJpbmcgY2hlY2sgZm9yIF9fc2NoZW1hXG4gICAgICAvLyBUaGlzIGF2b2lkcyBwYXJzaW5nIHRoZSBxdWVyeSBpbiBtb3N0IGNhc2VzXG4gICAgICAvLyBBbiBvcGVyYXRpb24gdGV4dCB0aGF0IGlzIG5vdCBhIHN0cmluZyBjYW5ub3QgYmUgaW5zcGVjdGVkIGF0IGFsbCwgc28gaXQgaXMgZGVuaWVkXG4gICAgICAvLyBmb3IgdGhlIHNhbWUgcmVhc29uOiB0aGlzIGd1YXJkIG11c3QgbmV2ZXIgbGV0IGFuIG9wZXJhdGlvbiB0aHJvdWdoIHVuaW5zcGVjdGVkLlxuICAgICAgaWYgKHR5cGVvZiBxdWVyeSAhPT0gJ3N0cmluZycgfHwgcXVlcnkuaW5jbHVkZXMoJ19fc2NoZW1hJykpIHtcbiAgICAgICAgcmV0dXJuIHRocm93SW50cm9zcGVjdGlvbkVycm9yKCk7XG4gICAgICB9XG5cbiAgICAgIC8vIFNtYXJ0IGNoZWNrIGZvciBfX3R5cGU6IG9ubHkgcGFyc2UgaWYgdGhlIHN0cmluZyBpcyBwcmVzZW50XG4gICAgICAvLyBUaGlzIGF2b2lkcyBmYWxzZSBwb3NpdGl2ZXMgKGUuZy4sIFwiX190eXBlXCIgaW4gc3RyaW5ncyBvciBjb21tZW50cylcbiAgICAgIC8vIHdoaWxlIHN0aWxsIGJlaW5nIGVmZmljaWVudCBmb3IgdGhlIGNvbW1vbiBjYXNlXG4gICAgICBpZiAocXVlcnkuaW5jbHVkZXMoJ19fdHlwZScpICYmIGhhc1R5cGVJbnRyb3NwZWN0aW9uKHF1ZXJ5KSkge1xuICAgICAgICByZXR1cm4gdGhyb3dJbnRyb3NwZWN0aW9uRXJyb3IoKTtcbiAgICAgIH1cbiAgICB9LFxuXG4gIH0pXG5cbn0pO1xuXG4vLyBncmFwaHFsLWpzIGVtYmVkcyBcIkRpZCB5b3UgbWVhbiAuLi4/XCIgaGludHMgc291cmNlZCBmcm9tIHRoZSBsaXZlIHNjaGVtYSBpblxuLy8gaXRzIGVycm9yIG1lc3NhZ2VzLiBUaGV5IGFyZSBwcm9kdWNlZCBpbiB0d28gZGlzdGluY3QgcGhhc2VzOlxuLy8gICAtIHZhbGlkYXRpb24gcnVsZXMgKEZpZWxkc09uQ29ycmVjdFR5cGVSdWxlLCBLbm93bkFyZ3VtZW50TmFtZXNSdWxlLFxuLy8gICAgIEtub3duVHlwZU5hbWVzUnVsZSwgLi4uKSwgYW5kXG4vLyAgIC0gdmFyaWFibGUgY29lcmNpb24gKHVua25vd24gZW51bSB2YWx1ZXMsIHVua25vd24gaW5wdXQtb2JqZWN0IGZpZWxkcyksXG4vLyAgICAgd2hpY2ggcnVucyBkdXJpbmcgZXhlY3V0aW9uLCBhZnRlciB2YWxpZGF0aW9uLlxuLy8gQWxsIG9mIHRoZXNlIGFyZSByZXR1cm5lZCB0byB0aGUgY2FsbGVyIGFuZCBkaXNjbG9zZSBzY2hlbWEgaWRlbnRpZmllcnMgKENsb3VkXG4vLyBDb2RlIGZ1bmN0aW9uIG5hbWVzLCBjbGFzcyBhbmQgZmllbGQgbmFtZXMpIHRoYXQgdGhlIGludHJvc3BlY3Rpb24gZ3VhcmQgaXNcbi8vIG1lYW50IHRvIGhpZGUuIFN0cmlwIHRoZSBoaW50IHN1ZmZpeCBmcm9tIGV2ZXJ5IHJldHVybmVkIGVycm9yIOKAlCBpbmNsdWRpbmcgdGhlXG4vLyBjb3B5IGdyYXBocWwtanMgZHVwbGljYXRlcyBpbnRvIGV4dGVuc2lvbnMuc3RhY2t0cmFjZSBpbiBub24tcHJvZHVjdGlvbiDigJQgZm9yXG4vLyBjYWxsZXJzIHRoYXQgYXJlIG5vdCBhbGxvd2VkIHRvIGludHJvc3BlY3QuXG5jb25zdCBzdHJpcFNjaGVtYVN1Z2dlc3Rpb24gPSBtZXNzYWdlID0+XG4gIHR5cGVvZiBtZXNzYWdlID09PSAnc3RyaW5nJyA/IG1lc3NhZ2UucmVwbGFjZSgvID9EaWQgeW91IG1lYW4oLis/KVxcPyQvLCAnJykgOiBtZXNzYWdlO1xuXG4vLyBncmFwaHFsLWpzIGFsc28gZW1pdHMgYSBiYXNlIGlucHV0LWNvZXJjaW9uIG1lc3NhZ2UgdGhhdCBuYW1lcyBhIHNjaGVtYVxuLy8gaWRlbnRpZmllciBXSVRIT1VUIGEgXCJEaWQgeW91IG1lYW5cIiBjbGF1c2UsIHNvIHRoZSBzdWdnZXN0aW9uIHN0cmlwIGFib3ZlXG4vLyBjYW5ub3QgcmVhY2ggaXQ6IHdoZW4gYSByZXF1aXJlZCBjdXN0b20gaW5wdXQgZmllbGQgaXMgb21pdHRlZCwgY29lcmNlSW5wdXRWYWx1ZVxuLy8gcmV0dXJucyAnRmllbGQgXCI8bmFtZT5cIiBvZiByZXF1aXJlZCB0eXBlIFwiPHR5cGU+XCIgd2FzIG5vdCBwcm92aWRlZC4nLCBkaXNjbG9zaW5nXG4vLyBhIGZpZWxkIG5hbWUgdGhlIGNhbGxlciBuZXZlciBzdXBwbGllZC4gUmVkYWN0IHRoZSBxdW90ZWQgaWRlbnRpZmllcnMgZnJvbSB0aGlzXG4vLyB0ZW1wbGF0ZSB3aGlsZSBwcmVzZXJ2aW5nIHRoZSBlcnJvciBzaGFwZSwgZm9yIGNhbGxlcnMgdGhhdCBhcmUgbm90IGFsbG93ZWQgdG9cbi8vIGludHJvc3BlY3QuIFRoZSBzaWJsaW5nIGNvZXJjaW9uIG1lc3NhZ2VzICgnLi4uIGlzIG5vdCBkZWZpbmVkIGJ5IHR5cGUgXCI8dHlwZT5cIi4nLFxuLy8gJ0V4cGVjdGVkIHR5cGUgXCI8dHlwZT5cIiB0byBiZSBhbiBvYmplY3QuJykgYXJlIGludGVudGlvbmFsbHkgbGVmdCBpbnRhY3Q6IHRoZXlcbi8vIG9ubHkgZWNobyBhbiBpbnB1dCB0eXBlIG5hbWUgdGhlIGNhbGxlciBhbHJlYWR5IHJlZmVyZW5jZWQgaW4gdGhlIG9wZXJhdGlvbiwgc29cbi8vIHRoZXkgZGlzY2xvc2Ugbm90aGluZyB0aGUgY2FsbGVyIGRpZCBub3QgYWxyZWFkeSBwcm92aWRlLlxuY29uc3Qgc3RyaXBTY2hlbWFDb2VyY2lvbklkZW50aWZpZXJzID0gbWVzc2FnZSA9PlxuICB0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZydcbiAgICA/IG1lc3NhZ2UucmVwbGFjZShcbiAgICAgIC9GaWVsZCBcIlteXCJdKlwiIG9mIHJlcXVpcmVkIHR5cGUgXCJbXlwiXSpcIiB3YXMgbm90IHByb3ZpZGVkXFwuL2csXG4gICAgICAnRmllbGQgb2YgcmVxdWlyZWQgdHlwZSB3YXMgbm90IHByb3ZpZGVkLidcbiAgICApXG4gICAgOiBtZXNzYWdlO1xuXG4vLyBUeXBlIG5hbWVzIHRoYXQgcmV2ZWFsIG5vdGhpbmcgYWJvdXQgVEhJUyBhcHBsaWNhdGlvbidzIHNjaGVtYSwgc28gcmVkYWN0aW5nIHRoZW0gd291bGQgY29zdFxuLy8gbWVzc2FnZSBxdWFsaXR5IGZvciBubyBzZWN1cml0eSBnYWluLiBgUkVTRVJWRURfR1JBUEhRTF9UWVBFX05BTUVTYCBjb3ZlcnMgdGhlIG5hbWVzIHRoZSBzY2hlbWFcbi8vIGJ1aWxkZXIgcmVmdXNlcyB0byBsZXQgYSBjbGFzcyBnZW5lcmF0ZSwgYnV0IFBhcnNlIHJlZ2lzdGVycyBidWlsdC1pbiB0eXBlcyBvdXRzaWRlIHRoYXQgbGlzdFxuLy8gdG9vLiBPZiB0aG9zZSwgb25seSBhbiBFTlVNIGNhbiByZWFjaCB0aGUgZW51bSB0ZW1wbGF0ZXMgYmVsb3csIGFuZCB0aGUgR3JhcGhRTCBsYXllciBkZWZpbmVzXG4vLyBleGFjdGx5IHRocmVlIGVudW1zOiBgQ2xvdWRDb2RlRnVuY3Rpb25gIChyZXNlcnZlZCksIHRoZSBwZXItY2xhc3MgYDxDbGFzcz5PcmRlcmAgKHRoZVxuLy8gZGlzY2xvc3VyZSB0aGVzZSB0ZW1wbGF0ZXMgZXhpc3QgdG8gcmVkYWN0KSBhbmQgYFJlYWRQcmVmZXJlbmNlYC4gSW5jbHVkZSB0aGUgbGFzdCBvbmUgc28gdGhhdFxuLy8gYW4gaW52YWxpZCBgb3B0aW9ucy5yZWFkUHJlZmVyZW5jZWAgdmFsdWUgc3RpbGwgbmFtZXMgaXRzIGVudW0sIGp1c3QgYXMgYENsb3VkQ29kZUZ1bmN0aW9uYFxuLy8gZG9lcyDigJQgaXQgaXMgaWRlbnRpY2FsIG9uIGV2ZXJ5IGRlcGxveW1lbnQgYW5kIHJlYWNoYWJsZSBmcm9tIGV2ZXJ5IGdlbmVyYXRlZCBmaW5kIHF1ZXJ5LlxuY29uc3QgTk9OX0RJU0NMT1NJTkdfVFlQRV9OQU1FUyA9IG5ldyBTZXQoWy4uLlJFU0VSVkVEX0dSQVBIUUxfVFlQRV9OQU1FUywgUkVBRF9QUkVGRVJFTkNFLm5hbWVdKTtcblxuLy8gZ3JhcGhxbC1qcyBhbHNvIGVtaXRzIGJhc2UgY29lcmNpb24gLyB2YWxpZGF0aW9uIG1lc3NhZ2VzIHRoYXQgbmFtZSBhIG5lc3RlZCBpbnB1dFxuLy8gVFlQRSB3aXRob3V0IGEgXCJEaWQgeW91IG1lYW5cIiBjbGF1c2UsIHNvIG5laXRoZXIgc3RyaXAgYWJvdmUgcmVhY2hlcyB0aGVtLiBGb3IgYVxuLy8gUG9pbnRlciBvciBSZWxhdGlvbiBmaWVsZCB0aGUgZ2VuZXJhdGVkIGlucHV0IHR5cGUgbmFtZSBlbWJlZHMgdGhlIHBvaW50ZXIncyBUQVJHRVRcbi8vIGNsYXNzIChgPFRhcmdldD5Qb2ludGVySW5wdXRgLCBgPFRhcmdldD5SZWxhdGlvbldoZXJlSW5wdXRgLCBgQ3JlYXRlPFRhcmdldD5GaWVsZHNJbnB1dGApXG4vLyDigJQgYSBjbGFzcyB0aGUgY2FsbGVyIG5ldmVyIHJlZmVyZW5jZWQgYW5kIGNhbm5vdCBkZXJpdmUgZnJvbSB0aGUgZmllbGQgbmFtZSB0aGV5XG4vLyBzdXBwbGllZCDigJQgc28gdGhlc2UgdGVtcGxhdGVzIGRpc2Nsb3NlIGEgc2NoZW1hIGNsYXNzIG5hbWUgdG8gYSBjYWxsZXIgd2hvIGhhcyBvbmx5IHRoZVxuLy8gcHVibGljIGFwcGxpY2F0aW9uIGlkLiBSZWRhY3QgdGhlIHF1b3RlZCB0eXBlIGlkZW50aWZpZXIgZnJvbSB0aG9zZSB0ZW1wbGF0ZXMgVU5MRVNTIHRoZVxuLy8gY2FsbGVyIHJlZmVyZW5jZWQgaXQgaW4gdGhlIG9wZXJhdGlvbiB0ZXh0OiBhIHR5cGUgbmFtZSB0aGUgY2FsbGVyIHdyb3RlIGluIHRoZSBvcGVyYXRpb25cbi8vIChlLmcuIGAkd2hlcmU6IFVzZXJXaGVyZUlucHV0YCkgaXMgbm90IGEgZGlzY2xvc3VyZSwgYW5kIHByZXNlcnZpbmcgaXQga2VlcHMgdGhlIG1lc3NhZ2Vcbi8vICgnLi4uIGlzIG5vdCBkZWZpbmVkIGJ5IHR5cGUgXCJVc2VyV2hlcmVJbnB1dFwiLicpIHVzZWZ1bC4gV2hlbiB0aGUgb3BlcmF0aW9uIHRleHQgaXNcbi8vIHVuYXZhaWxhYmxlIHRoZSBpZGVudGlmaWVyIGlzIHJlZGFjdGVkIChmYWlsIGNsb3NlZCkuXG5jb25zdCBzdHJpcFNjaGVtYVR5cGVJZGVudGlmaWVycyA9IChtZXNzYWdlLCBvcGVyYXRpb25UZXh0KSA9PiB7XG4gIGlmICh0eXBlb2YgbWVzc2FnZSAhPT0gJ3N0cmluZycpIHsgcmV0dXJuIG1lc3NhZ2U7IH1cbiAgLy8gQSBnZW5lcmF0ZWQgdHlwZSBpZGVudGlmaWVyIGlzIGtlcHQgKGl0IGlzIG5vdCBhIGRpc2Nsb3N1cmUpIGlmIHRoZSBjYWxsZXIgd3JvdGUgaXQgYXMgYVxuICAvLyB3aG9sZSB0b2tlbiBpbiB0aGUgb3BlcmF0aW9uIHRleHQsIG9yIGlmIGl0IGlzIGEgbm9uLWRpc2Nsb3NpbmcgbmFtZSAoYWJvdmUpLiBUb2tlbml6ZSB0aGVcbiAgLy8gb3BlcmF0aW9uIG9uIG5vbi1pZGVudGlmaWVyIGNoYXJhY3RlcnMgYW5kIGNvbXBhcmUgZXhhY3QgdG9rZW5zIHJhdGhlciB0aGFuIGJ1aWxkaW5nIGFcbiAgLy8gUmVnRXhwIGZyb20gdGhlIGNhcHR1cmVkIG5hbWU6IHRoaXMgYXZvaWRzIHN1YnN0cmluZyBmYWxzZS1tYXRjaGVzIChlLmcuIHByZXNlcnZpbmdcbiAgLy8gXCJBdXRob3JQb2ludGVySW5wdXRcIiBiZWNhdXNlIHRoZSBvcGVyYXRpb24gY29udGFpbnMgXCJTZWNyZXRBdXRob3JQb2ludGVySW5wdXRcIikgYW5kIGFueVxuICAvLyByZWdleCBpbmplY3Rpb24vUmVEb1MgZnJvbSBhbiB1bnVzdWFsIGNhcHR1cmVkIG5hbWUuIEdyYXBoUUwgbGlzdC9ub24tbnVsbCB3cmFwcGVycyAoXCJbXCIsXG4gIC8vIFwiXVwiLCBcIiFcIikgYXJlIHN0cmlwcGVkIGZyb20gdGhlIGNhcHR1cmVkIG5hbWUgc28gZS5nLiBcIlNlY3JldEF1dGhvclBvaW50ZXJJbnB1dCFcIiBzdGlsbFxuICAvLyBtYXRjaGVzIFwiJHg6IFNlY3JldEF1dGhvclBvaW50ZXJJbnB1dCFcIi4gV2hlbiB0aGUgb3BlcmF0aW9uIHRleHQgaXMgdW5hdmFpbGFibGUgdGhlIHR5cGUgaXNcbiAgLy8gdHJlYXRlZCBhcyBub3QgcmVmZXJlbmNlZCAoZmFpbCBjbG9zZWQpLlxuICBjb25zdCByZWZlcmVuY2VkVG9rZW5zID1cbiAgICB0eXBlb2Ygb3BlcmF0aW9uVGV4dCA9PT0gJ3N0cmluZydcbiAgICAgID8gbmV3IFNldChvcGVyYXRpb25UZXh0LnNwbGl0KC9bXl9BLVphLXowLTldKy8pLmZpbHRlcihCb29sZWFuKSlcbiAgICAgIDogbmV3IFNldCgpO1xuICAvLyBBIG5vbi1kaXNjbG9zaW5nIHR5cGUgbmFtZSAoYENsb3VkQ29kZUZ1bmN0aW9uYCwgYFJlYWRQcmVmZXJlbmNlYCwgYFZpZXdlcmAsIGBQYWdlSW5mb2AsIHRoZVxuICAvLyBidWlsdC1pbiBzY2FsYXJzLCAuLi4pIGlzIGlkZW50aWNhbCBvbiBldmVyeSBQYXJzZSBTZXJ2ZXIgZGVwbG95bWVudCBhbmQgY2Fubm90IGNvbGxpZGUgd2l0aFxuICAvLyBhIHVzZXIgY2xhc3MsIHNpbmNlIGBQYXJzZUdyYXBoUUxTY2hlbWFgIHJlamVjdHMgY2xhc3MgbmFtZXMgdGhhdCB3b3VsZCBwcm9kdWNlIG9uZS4gRWNob2luZ1xuICAvLyBvbmUgdGhlcmVmb3JlIGRpc2Nsb3NlcyBub3RoaW5nIGFib3V0IFRISVMgYXBwbGljYXRpb24ncyBzY2hlbWEsIHNvIGl0IGlzIHByZXNlcnZlZCBsaWtlIGFcbiAgLy8gY2FsbGVyLXJlZmVyZW5jZWQgbmFtZSBhbmQgdGhlIG1lc3NhZ2Ugc3RheXMgdXNlZnVsLlxuICBjb25zdCBzaG91bGRLZWVwVHlwZU5hbWUgPSB0eXBlTmFtZSA9PiB7XG4gICAgY29uc3QgYmFyZVR5cGVOYW1lID0gdHlwZU5hbWUucmVwbGFjZSgvW1tcXF0hXS9nLCAnJyk7XG4gICAgcmV0dXJuIE5PTl9ESVNDTE9TSU5HX1RZUEVfTkFNRVMuaGFzKGJhcmVUeXBlTmFtZSkgfHwgcmVmZXJlbmNlZFRva2Vucy5oYXMoYmFyZVR5cGVOYW1lKTtcbiAgfTtcbiAgcmV0dXJuIG1lc3NhZ2VcbiAgICAvLyBJbnB1dCBjb2VyY2lvbiAvIFZhbHVlc09mQ29ycmVjdFR5cGVSdWxlICh2YXJpYWJsZXMgYW5kIGlubGluZSBsaXRlcmFscykuXG4gICAgLnJlcGxhY2UoL0V4cGVjdGVkIHZhbHVlIG9mIHR5cGUgXCIoW15cIl0rKVwiL2csIChtYXRjaCwgdHlwZU5hbWUpID0+XG4gICAgICBzaG91bGRLZWVwVHlwZU5hbWUodHlwZU5hbWUpID8gbWF0Y2ggOiAnRXhwZWN0ZWQgdmFsdWUgb2YgdGhlIGNvcnJlY3QgdHlwZSdcbiAgICApXG4gICAgLnJlcGxhY2UoL0V4cGVjdGVkIHR5cGUgXCIoW15cIl0rKVwiIHRvIGJlIGFuIG9iamVjdFxcLi9nLCAobWF0Y2gsIHR5cGVOYW1lKSA9PlxuICAgICAgc2hvdWxkS2VlcFR5cGVOYW1lKHR5cGVOYW1lKSA/IG1hdGNoIDogJ0V4cGVjdGVkIGFuIG9iamVjdC4nXG4gICAgKVxuICAgIC5yZXBsYWNlKC9FeHBlY3RlZCBub24tbnVsbGFibGUgdHlwZSBcIihbXlwiXSspXCIgbm90IHRvIGJlIG51bGxcXC4vZywgKG1hdGNoLCB0eXBlTmFtZSkgPT5cbiAgICAgIHNob3VsZEtlZXBUeXBlTmFtZSh0eXBlTmFtZSkgPyBtYXRjaCA6ICdFeHBlY3RlZCBhIG5vbi1udWxsIHZhbHVlLidcbiAgICApXG4gICAgLnJlcGxhY2UoLyBpcyBub3QgZGVmaW5lZCBieSB0eXBlIFwiKFteXCJdKylcIlxcLi9nLCAobWF0Y2gsIHR5cGVOYW1lKSA9PlxuICAgICAgc2hvdWxkS2VlcFR5cGVOYW1lKHR5cGVOYW1lKSA/IG1hdGNoIDogJyBpcyBub3QgZGVmaW5lZC4nXG4gICAgKVxuICAgIC8vIFZhcmlhYmxlc0luQWxsb3dlZFBvc2l0aW9uUnVsZTogdGhlIHBvc2l0aW9uIHR5cGUgaXMgdGhlIHBvaW50ZXIvcmVsYXRpb24gdGFyZ2V0XG4gICAgLy8gaW5wdXQgdHlwZTsgdGhlIGNhbGxlciBvbmx5IHdyb3RlIHRoZWlyIG93biB2YXJpYWJsZSdzIGRlY2xhcmVkIHR5cGUuXG4gICAgLnJlcGxhY2UoLyB1c2VkIGluIHBvc2l0aW9uIGV4cGVjdGluZyB0eXBlIFwiKFteXCJdKylcIlxcLi9nLCAobWF0Y2gsIHR5cGVOYW1lKSA9PlxuICAgICAgc2hvdWxkS2VlcFR5cGVOYW1lKHR5cGVOYW1lKSA/IG1hdGNoIDogJyB1c2VkIGluIHBvc2l0aW9uIGV4cGVjdGluZyBhIGRpZmZlcmVudCB0eXBlLidcbiAgICApXG4gICAgLy8gRmllbGRzT25Db3JyZWN0VHlwZVJ1bGU6IGRlc2NlbmRpbmcgaW50byBhIFBvaW50ZXIvUmVsYXRpb24gb3V0cHV0IGZpZWxkIG5hbWVzIGl0c1xuICAgIC8vIHRhcmdldCBvdXRwdXQgb2JqZWN0IHR5cGUuXG4gICAgLnJlcGxhY2UoL0Nhbm5vdCBxdWVyeSBmaWVsZCAoXCJbXlwiXSpcIikgb24gdHlwZSBcIihbXlwiXSspXCJcXC4vZywgKG1hdGNoLCBmaWVsZE5hbWUsIHR5cGVOYW1lKSA9PlxuICAgICAgc2hvdWxkS2VlcFR5cGVOYW1lKHR5cGVOYW1lKSA/IG1hdGNoIDogYENhbm5vdCBxdWVyeSBmaWVsZCAke2ZpZWxkTmFtZX0uYFxuICAgIClcbiAgICAvLyBTY2FsYXJMZWFmc1J1bGU6IHNlbGVjdGluZyBhIFBvaW50ZXIvUmVsYXRpb24gb3V0cHV0IGZpZWxkIHdpdGggbm8gc3ViLXNlbGVjdGlvbiBuYW1lc1xuICAgIC8vIGl0cyB0YXJnZXQgb3V0cHV0IG9iamVjdCB0eXBlLlxuICAgIC5yZXBsYWNlKFxuICAgICAgL0ZpZWxkIChcIlteXCJdKlwiKSBvZiB0eXBlIFwiKFteXCJdKylcIiBtdXN0IGhhdmUgYSBzZWxlY3Rpb24gb2Ygc3ViZmllbGRzXFwuL2csXG4gICAgICAobWF0Y2gsIGZpZWxkTmFtZSwgdHlwZU5hbWUpID0+XG4gICAgICAgIHNob3VsZEtlZXBUeXBlTmFtZSh0eXBlTmFtZSlcbiAgICAgICAgICA/IG1hdGNoXG4gICAgICAgICAgOiBgRmllbGQgJHtmaWVsZE5hbWV9IG11c3QgaGF2ZSBhIHNlbGVjdGlvbiBvZiBzdWJmaWVsZHMuYFxuICAgIClcbiAgICAvLyBQb3NzaWJsZUZyYWdtZW50U3ByZWFkc1J1bGU6IGFuIGlubGluZS9uYW1lZCBmcmFnbWVudCBvbiBhbiBpbmNvbXBhdGlibGUgdHlwZSBpbnNpZGUgYVxuICAgIC8vIFBvaW50ZXIvUmVsYXRpb24gb3V0cHV0IGZpZWxkIG5hbWVzIHRoZSB0YXJnZXQgb3V0cHV0IG9iamVjdCB0eXBlICh0aGUgcGFyZW50IHR5cGUpLlxuICAgIC8vIFJlZGFjdCBlYWNoIHR5cGUgdG9rZW4gdGhlIGNhbGxlciBkaWQgbm90IHJlZmVyZW5jZTsgd2hlbiBib3RoIGFyZSByZWZlcmVuY2VkIHRoZVxuICAgIC8vIHJlY29uc3RydWN0aW9uIGlzIGlkZW50aWNhbCB0byB0aGUgb3JpZ2luYWwgbWVzc2FnZS5cbiAgICAucmVwbGFjZShcbiAgICAgIC9vYmplY3RzIG9mIHR5cGUgXCIoW15cIl0rKVwiIGNhbiBuZXZlciBiZSBvZiB0eXBlIFwiKFteXCJdKylcIlxcLi9nLFxuICAgICAgKG1hdGNoLCBwYXJlbnRUeXBlLCBmcmFnVHlwZSkgPT4ge1xuICAgICAgICBjb25zdCBwYXJlbnQgPSBzaG91bGRLZWVwVHlwZU5hbWUocGFyZW50VHlwZSkgPyBgdHlwZSBcIiR7cGFyZW50VHlwZX1cImAgOiAndGhlIHBhcmVudCB0eXBlJztcbiAgICAgICAgY29uc3QgZnJhZyA9IHNob3VsZEtlZXBUeXBlTmFtZShmcmFnVHlwZSkgPyBgdHlwZSBcIiR7ZnJhZ1R5cGV9XCJgIDogJ3RoZSBnaXZlbiB0eXBlJztcbiAgICAgICAgcmV0dXJuIGBvYmplY3RzIG9mICR7cGFyZW50fSBjYW4gbmV2ZXIgYmUgb2YgJHtmcmFnfS5gO1xuICAgICAgfVxuICAgIClcbiAgICAvLyBLbm93bkFyZ3VtZW50TmFtZXNSdWxlOiB0aGUgYXJndW1lbnQncyBwYXJlbnQgT1VUUFVUIHR5cGUuIEluc2lkZSBhIFBvaW50ZXIvUmVsYXRpb25cbiAgICAvLyBzdWItc2VsZWN0aW9uIHRoYXQgcGFyZW50IGlzIHRoZSBUQVJHRVQgY2xhc3MsIHdob3NlIG91dHB1dCB0eXBlIGlzIG5hbWVkIGV4YWN0bHkgdGhlXG4gICAgLy8gY2xhc3MgbmFtZSAoYHBhcnNlQ2xhc3NUeXBlcy5qc2ApLCBzbyBpdCBkaXNjbG9zZXMgYSBjbGFzcyB0aGUgY2FsbGVyIG5ldmVyIHdyb3RlIOKAlCB0aGV5XG4gICAgLy8gb25seSBzdXBwbGllZCB0aGUgcG9pbnRlciBmaWVsZCBuYW1lLiBUaGUgdHlwZSBpcyBlbWJlZGRlZCBpbiBhIGRvdHRlZCBcIjxUeXBlPi48ZmllbGQ+XCJcbiAgICAvLyB0b2tlbjsga2VlcCB0aGUgZmllbGQgbmFtZSAodGhlIGNhbGxlciB3cm90ZSBpdCkgYW5kIHJlZGFjdCBvbmx5IHRoZSB0eXBlIGhhbGYuIE5vdGUgdGhlXG4gICAgLy8gZGlyZWN0aXZlIGZvcm0gKCcuLi4gb24gZGlyZWN0aXZlIFwiQG5hbWVcIi4nKSBjYXJyaWVzIG5vIHR5cGUgYW5kIGlzIGxlZnQgYWxvbmUuXG4gICAgLnJlcGxhY2UoXG4gICAgICAvVW5rbm93biBhcmd1bWVudCAoXCJbXlwiXSpcIikgb24gZmllbGQgXCIoW15cIi5dKylcXC4oW15cIi5dKylcIlxcLi9nLFxuICAgICAgKG1hdGNoLCBhcmdOYW1lLCB0eXBlTmFtZSwgZmllbGROYW1lKSA9PlxuICAgICAgICBzaG91bGRLZWVwVHlwZU5hbWUodHlwZU5hbWUpXG4gICAgICAgICAgPyBtYXRjaFxuICAgICAgICAgIDogYFVua25vd24gYXJndW1lbnQgJHthcmdOYW1lfSBvbiBmaWVsZCBcIiR7ZmllbGROYW1lfVwiLmBcbiAgICApXG4gICAgLy8gR3JhcGhRTEVudW1UeXBlLnBhcnNlVmFsdWUvcGFyc2VMaXRlcmFsOiBhIFJlbGF0aW9uIGZpZWxkJ3MgYG9yZGVyYCBhcmd1bWVudCBpcyB0eXBlZFxuICAgIC8vIGBbPFRhcmdldD5PcmRlciFdYCAoYHBhcnNlQ2xhc3NUeXBlcy5qc2ApLCBzbyBhbiBpbnZhbGlkIGVudW0gbGl0ZXJhbCBuYW1lcyB0aGUgdGFyZ2V0XG4gICAgLy8gY2xhc3MuIFRoZXNlIG1lc3NhZ2VzIGNvbWUgZnJvbSB0aGUgZW51bSB0eXBlIGl0c2VsZiByYXRoZXIgdGhhbiBmcm9tIGEgdmFsaWRhdGlvbiBydWxlLFxuICAgIC8vIHdoaWNoIGlzIHdoeSB0aGUgVmFsdWVzT2ZDb3JyZWN0VHlwZVJ1bGUgdGVtcGxhdGVzIGFib3ZlIGRvIG5vdCByZWFjaCB0aGVtLiBUaGUgb2ZmZW5kaW5nXG4gICAgLy8gdmFsdWUgaXMgY2FsbGVyLXN1cHBsaWVkIGFuZCBpcyBwcmVzZXJ2ZWQ7IG9ubHkgdGhlIGVudW0gdHlwZSBuYW1lIGlzIHJlZGFjdGVkLlxuICAgIC5yZXBsYWNlKC9WYWx1ZSAoXCJbXlwiXSpcIikgZG9lcyBub3QgZXhpc3QgaW4gXCIoW15cIl0rKVwiIGVudW1cXC4vZywgKG1hdGNoLCB2YWx1ZSwgdHlwZU5hbWUpID0+XG4gICAgICBzaG91bGRLZWVwVHlwZU5hbWUodHlwZU5hbWUpID8gbWF0Y2ggOiBgVmFsdWUgJHt2YWx1ZX0gZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudW0uYFxuICAgIClcbiAgICAvLyBTaWJsaW5nIGJyYW5jaGVzIG9mIHRoZSBzYW1lIGVudW0gdHlwZSwgcmVhY2hlZCB3aGVuIHRoZSBsaXRlcmFsIGlzIG5vdCBhbiBlbnVtIHZhbHVlIGF0XG4gICAgLy8gYWxsICgnY2Fubm90IHJlcHJlc2VudCBub24tZW51bSB2YWx1ZTogLi4uJywgJ2Nhbm5vdCByZXByZXNlbnQgbm9uLXN0cmluZyB2YWx1ZTogLi4uJyxcbiAgICAvLyAnY2Fubm90IHJlcHJlc2VudCB2YWx1ZTogLi4uJykuIFNhbWUgZGlzY2xvc3VyZSwgc2FtZSByZWRhY3Rpb24uXG4gICAgLnJlcGxhY2UoL0VudW0gXCIoW15cIl0rKVwiIGNhbm5vdCByZXByZXNlbnQgL2csIChtYXRjaCwgdHlwZU5hbWUpID0+XG4gICAgICBzaG91bGRLZWVwVHlwZU5hbWUodHlwZU5hbWUpID8gbWF0Y2ggOiAnRW51bSBjYW5ub3QgcmVwcmVzZW50ICdcbiAgICApO1xufTtcblxuY29uc3Qgc3RyaXBTY2hlbWFJZGVudGlmaWVycyA9IChtZXNzYWdlLCBvcGVyYXRpb25UZXh0KSA9PlxuICBzdHJpcFNjaGVtYVR5cGVJZGVudGlmaWVycyhcbiAgICBzdHJpcFNjaGVtYUNvZXJjaW9uSWRlbnRpZmllcnMoc3RyaXBTY2hlbWFTdWdnZXN0aW9uKG1lc3NhZ2UpKSxcbiAgICBvcGVyYXRpb25UZXh0XG4gICk7XG5cbmNvbnN0IFNjaGVtYVN1Z2dlc3Rpb25zQ29udHJvbFBsdWdpbiA9IChwdWJsaWNJbnRyb3NwZWN0aW9uKSA9PiAoe1xuICByZXF1ZXN0RGlkU3RhcnQ6IGFzeW5jIChyZXF1ZXN0Q29udGV4dCkgPT4gKHtcbiAgICB3aWxsU2VuZFJlc3BvbnNlOiBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAocHVibGljSW50cm9zcGVjdGlvbikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zdCBpc01hc3Rlck9yTWFpbnRlbmFuY2UgPVxuICAgICAgICByZXF1ZXN0Q29udGV4dC5jb250ZXh0VmFsdWUuYXV0aD8uaXNNYXN0ZXIgfHxcbiAgICAgICAgcmVxdWVzdENvbnRleHQuY29udGV4dFZhbHVlLmF1dGg/LmlzTWFpbnRlbmFuY2U7XG4gICAgICBpZiAoaXNNYXN0ZXJPck1haW50ZW5hbmNlKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGJvZHkgPSByZXF1ZXN0Q29udGV4dC5yZXNwb25zZT8uYm9keTtcbiAgICAgIGNvbnN0IGVycm9ycyA9XG4gICAgICAgIGJvZHk/LmtpbmQgPT09ICdzaW5nbGUnXG4gICAgICAgICAgPyBib2R5LnNpbmdsZVJlc3VsdC5lcnJvcnNcbiAgICAgICAgICA6IGJvZHk/LmtpbmQgPT09ICdpbmNyZW1lbnRhbCdcbiAgICAgICAgICAgID8gYm9keS5pbml0aWFsUmVzdWx0LmVycm9yc1xuICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAvLyBTYW1lIGFzIGluIGBJbnRyb3NwZWN0aW9uQ29udHJvbFBsdWdpbmA6IGByZXF1ZXN0Q29udGV4dC5zb3VyY2VgIGNhcnJpZXMgdGhlXG4gICAgICAvLyBvcGVyYXRpb24gdGV4dCBmb3IgZXZlcnkgcmVxdWVzdCwgaW5jbHVkaW5nIGFuIGF1dG9tYXRpYyBwZXJzaXN0ZWQgcXVlcnkgY2FjaGUgaGl0XG4gICAgICAvLyB3aGVyZSBgcmVxdWVzdC5xdWVyeWAgaXMgdW5kZWZpbmVkLiBSZWFkaW5nIGByZXF1ZXN0LnF1ZXJ5YCBhbG9uZSB3b3VsZCBtYWtlIHRoZVxuICAgICAgLy8gYWxsb3dsaXN0IGJlbG93IGVtcHR5IG9uIHRob3NlIHJlcXVlc3RzIGFuZCByZWRhY3QgdHlwZSBuYW1lcyB0aGUgY2FsbGVyIHdyb3RlXG4gICAgICAvLyB0aGVtc2VsdmVzLlxuICAgICAgY29uc3Qgb3BlcmF0aW9uVGV4dCA9IHJlcXVlc3RDb250ZXh0LnNvdXJjZSA/PyByZXF1ZXN0Q29udGV4dC5yZXF1ZXN0Py5xdWVyeTtcbiAgICAgIGVycm9ycz8uZm9yRWFjaChlcnJvciA9PiB7XG4gICAgICAgIGVycm9yLm1lc3NhZ2UgPSBzdHJpcFNjaGVtYUlkZW50aWZpZXJzKGVycm9yLm1lc3NhZ2UsIG9wZXJhdGlvblRleHQpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlcnJvci5leHRlbnNpb25zPy5zdGFja3RyYWNlKSkge1xuICAgICAgICAgIGVycm9yLmV4dGVuc2lvbnMuc3RhY2t0cmFjZSA9IGVycm9yLmV4dGVuc2lvbnMuc3RhY2t0cmFjZS5tYXAobWVzc2FnZSA9PlxuICAgICAgICAgICAgc3RyaXBTY2hlbWFJZGVudGlmaWVycyhtZXNzYWdlLCBvcGVyYXRpb25UZXh0KVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH0sXG4gIH0pLFxufSk7XG5cbmNsYXNzIFBhcnNlR3JhcGhRTFNlcnZlciB7XG4gIHBhcnNlR3JhcGhRTENvbnRyb2xsZXI6IFBhcnNlR3JhcGhRTENvbnRyb2xsZXI7XG5cbiAgY29uc3RydWN0b3IocGFyc2VTZXJ2ZXIsIGNvbmZpZykge1xuICAgIHRoaXMucGFyc2VTZXJ2ZXIgPSBwYXJzZVNlcnZlciB8fCByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIHBhcnNlU2VydmVyIGluc3RhbmNlIScpO1xuICAgIGlmICghY29uZmlnIHx8ICFjb25maWcuZ3JhcGhRTFBhdGgpIHtcbiAgICAgIHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgY29uZmlnLmdyYXBoUUxQYXRoIScpO1xuICAgIH1cbiAgICB0aGlzLmNvbmZpZyA9IGNvbmZpZztcbiAgICB0aGlzLnBhcnNlR3JhcGhRTENvbnRyb2xsZXIgPSB0aGlzLnBhcnNlU2VydmVyLmNvbmZpZy5wYXJzZUdyYXBoUUxDb250cm9sbGVyO1xuICAgIHRoaXMubG9nID1cbiAgICAgICh0aGlzLnBhcnNlU2VydmVyLmNvbmZpZyAmJiB0aGlzLnBhcnNlU2VydmVyLmNvbmZpZy5sb2dnZXJDb250cm9sbGVyKSB8fCBkZWZhdWx0TG9nZ2VyO1xuICAgIHRoaXMucGFyc2VHcmFwaFFMU2NoZW1hID0gbmV3IFBhcnNlR3JhcGhRTFNjaGVtYSh7XG4gICAgICBwYXJzZUdyYXBoUUxDb250cm9sbGVyOiB0aGlzLnBhcnNlR3JhcGhRTENvbnRyb2xsZXIsXG4gICAgICBkYXRhYmFzZUNvbnRyb2xsZXI6IHRoaXMucGFyc2VTZXJ2ZXIuY29uZmlnLmRhdGFiYXNlQ29udHJvbGxlcixcbiAgICAgIGxvZzogdGhpcy5sb2csXG4gICAgICBncmFwaFFMQ3VzdG9tVHlwZURlZnM6IHRoaXMuY29uZmlnLmdyYXBoUUxDdXN0b21UeXBlRGVmcyxcbiAgICAgIGFwcElkOiB0aGlzLnBhcnNlU2VydmVyLmNvbmZpZy5hcHBJZCxcbiAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIF9nZXRHcmFwaFFMT3B0aW9ucygpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgc2NoZW1hOiBhd2FpdCB0aGlzLnBhcnNlR3JhcGhRTFNjaGVtYS5sb2FkKCksXG4gICAgICAgIGNvbnRleHQ6IGFzeW5jICh7IHJlcSB9KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGluZm86IHJlcS5pbmZvLFxuICAgICAgICAgICAgY29uZmlnOiByZXEuY29uZmlnLFxuICAgICAgICAgICAgYXV0aDogcmVxLmF1dGgsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhpcy5sb2cuZXJyb3IoZS5zdGFjayB8fCAodHlwZW9mIGUudG9TdHJpbmcgPT09ICdmdW5jdGlvbicgJiYgZS50b1N0cmluZygpKSB8fCBlKTtcbiAgICAgIHRocm93IGU7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX2dldFNlcnZlcigpIHtcbiAgICBjb25zdCBzY2hlbWFSZWYgPSB0aGlzLnBhcnNlR3JhcGhRTFNjaGVtYS5ncmFwaFFMU2NoZW1hO1xuICAgIGNvbnN0IG5ld1NjaGVtYVJlZiA9IGF3YWl0IHRoaXMucGFyc2VHcmFwaFFMU2NoZW1hLmxvYWQoKTtcbiAgICBpZiAoc2NoZW1hUmVmID09PSBuZXdTY2hlbWFSZWYgJiYgdGhpcy5fc2VydmVyKSB7XG4gICAgICByZXR1cm4gdGhpcy5fc2VydmVyO1xuICAgIH1cbiAgICAvLyBJdCBtZWFucyBhIHBhcmFsbGVsIF9nZXRTZXJ2ZXIgY2FsbCBpcyBhbHJlYWR5IGluIHByb2dyZXNzXG4gICAgaWYgKHRoaXMuX3NjaGVtYVJlZk11dGV4ID09PSBuZXdTY2hlbWFSZWYpIHtcbiAgICAgIHJldHVybiB0aGlzLl9zZXJ2ZXI7XG4gICAgfVxuICAgIC8vIFVwZGF0ZSB0aGUgc2NoZW1hIHJlZiBtdXRleCB0byBhdm9pZCBwYXJhbGxlbCBfZ2V0U2VydmVyIGNhbGxzXG4gICAgdGhpcy5fc2NoZW1hUmVmTXV0ZXggPSBuZXdTY2hlbWFSZWY7XG4gICAgY29uc3QgY3JlYXRlU2VydmVyID0gYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBzY2hlbWEsIGNvbnRleHQgfSA9IGF3YWl0IHRoaXMuX2dldEdyYXBoUUxPcHRpb25zKCk7XG4gICAgICAgIC8vIEEgdmFsdWUgcGFzc2VkIHRvIHRoaXMgR3JhcGhRTCBzZXJ2ZXIgdGFrZXMgcHJlY2VkZW5jZTsgb3RoZXJ3aXNlIHVzZSB0aGUgUGFyc2UgU2VydmVyXG4gICAgICAgIC8vIG9wdGlvbiwgd2hlcmUgdGhlIG9wdGlvbiBpcyBkb2N1bWVudGVkIGFuZCB3aGVyZSB0aGUgc2VjdXJpdHkgY2hlY2sgcmVhZHMgaXQuXG4gICAgICAgIGNvbnN0IHB1YmxpY0ludHJvc3BlY3Rpb24gPVxuICAgICAgICAgIHRoaXMuY29uZmlnLmdyYXBoUUxQdWJsaWNJbnRyb3NwZWN0aW9uID8/XG4gICAgICAgICAgdGhpcy5wYXJzZVNlcnZlci5jb25maWcuZ3JhcGhRTFB1YmxpY0ludHJvc3BlY3Rpb247XG4gICAgICAgIGNvbnN0IGFwb2xsbyA9IG5ldyBBcG9sbG9TZXJ2ZXIoe1xuICAgICAgICAgIGNzcmZQcmV2ZW50aW9uOiB7XG4gICAgICAgICAgICAvLyBTZWUgaHR0cHM6Ly93d3cuYXBvbGxvZ3JhcGhxbC5jb20vZG9jcy9yb3V0ZXIvY29uZmlndXJhdGlvbi9jc3JmL1xuICAgICAgICAgICAgLy8gbmVlZGVkIHNpbmNlIHdlIHVzZSBncmFwaHFsIHVwbG9hZFxuICAgICAgICAgICAgcmVxdWVzdEhlYWRlcnM6IFsnWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCddLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgLy8gV2UgbmVlZCBhbHdheXMgdHJ1ZSBpbnRyb3NwZWN0aW9uIGJlY2F1c2UgYXBvbGxvIHNlcnZlciBoYXZlIGNoYW5naW5nIGJlaGF2aW9yIGJhc2VkIG9uIHRoZSBOT0RFX0VOViB2YXJpYWJsZVxuICAgICAgICAgIC8vIHdlIGRlbGVnYXRlIHRoZSBpbnRyb3NwZWN0aW9uIGNvbnRyb2wgdG8gdGhlIEludHJvc3BlY3Rpb25Db250cm9sUGx1Z2luXG4gICAgICAgICAgaW50cm9zcGVjdGlvbjogdHJ1ZSxcbiAgICAgICAgICBwbHVnaW5zOiBbQXBvbGxvU2VydmVyUGx1Z2luQ2FjaGVDb250cm9sRGlzYWJsZWQoKSwgSW50cm9zcGVjdGlvbkNvbnRyb2xQbHVnaW4ocHVibGljSW50cm9zcGVjdGlvbiksIFNjaGVtYVN1Z2dlc3Rpb25zQ29udHJvbFBsdWdpbihwdWJsaWNJbnRyb3NwZWN0aW9uKSwgY3JlYXRlQ29tcGxleGl0eVZhbGlkYXRpb25QbHVnaW4oKCkgPT4gdGhpcy5wYXJzZVNlcnZlci5jb25maWcucmVxdWVzdENvbXBsZXhpdHkpXSxcbiAgICAgICAgICBzY2hlbWEsXG4gICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhcG9sbG8uc3RhcnQoKTtcbiAgICAgICAgcmV0dXJuIGV4cHJlc3NNaWRkbGV3YXJlKGFwb2xsbywge1xuICAgICAgICAgIGNvbnRleHQsXG4gICAgICAgIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvLyBSZXNldCBhbGwgbXV0ZXhlcyBhbmQgZm9yd2FyZCB0aGUgZXJyb3JcbiAgICAgICAgdGhpcy5fc2VydmVyID0gbnVsbDtcbiAgICAgICAgdGhpcy5fc2NoZW1hUmVmTXV0ZXggPSBudWxsO1xuICAgICAgICB0aHJvdyBlO1xuICAgICAgfVxuICAgIH1cbiAgICAvLyBEbyBub3QgYXdhaXQgc28gcGFyYWxsZWwgcmVxdWVzdCB3aWxsIHdhaXQgdGhlIHNhbWUgcHJvbWlzZSByZWZcbiAgICB0aGlzLl9zZXJ2ZXIgPSBjcmVhdGVTZXJ2ZXIoKTtcbiAgICByZXR1cm4gdGhpcy5fc2VydmVyO1xuICB9XG5cbiAgX3RyYW5zZm9ybU1heFVwbG9hZFNpemVUb0J5dGVzKG1heFVwbG9hZFNpemUpIHtcbiAgICBjb25zdCB1bml0TWFwID0ge1xuICAgICAga2I6IDEsXG4gICAgICBtYjogMixcbiAgICAgIGdiOiAzLFxuICAgIH07XG5cbiAgICByZXR1cm4gKFxuICAgICAgTnVtYmVyKG1heFVwbG9hZFNpemUuc2xpY2UoMCwgLTIpKSAqXG4gICAgICBNYXRoLnBvdygxMDI0LCB1bml0TWFwW21heFVwbG9hZFNpemUuc2xpY2UoLTIpLnRvTG93ZXJDYXNlKCldKVxuICAgICk7XG4gIH1cblxuICAvKipcbiAgICogQHN0YXRpY1xuICAgKiBBbGxvdyBkZXZlbG9wZXJzIHRvIGN1c3RvbWl6ZSBlYWNoIHJlcXVlc3Qgd2l0aCBpbnZlcnNpb24gb2YgY29udHJvbC9kZXBlbmRlbmN5IGluamVjdGlvblxuICAgKi9cbiAgYXBwbHlSZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUoYXBpLCBvcHRpb25zKSB7XG4gICAgaWYgKG9wdGlvbnMucmVxdWVzdENvbnRleHRNaWRkbGV3YXJlKSB7XG4gICAgICBpZiAodHlwZW9mIG9wdGlvbnMucmVxdWVzdENvbnRleHRNaWRkbGV3YXJlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcigncmVxdWVzdENvbnRleHRNaWRkbGV3YXJlIG11c3QgYmUgYSBmdW5jdGlvbicpO1xuICAgICAgfVxuICAgICAgYXBpLnVzZSh0aGlzLmNvbmZpZy5ncmFwaFFMUGF0aCwgb3B0aW9ucy5yZXF1ZXN0Q29udGV4dE1pZGRsZXdhcmUpO1xuICAgIH1cbiAgfVxuXG4gIGFwcGx5R3JhcGhRTChhcHApIHtcbiAgICBpZiAoIWFwcCB8fCAhYXBwLnVzZSkge1xuICAgICAgcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYW4gRXhwcmVzcy5qcyBhcHAgaW5zdGFuY2UhJyk7XG4gICAgfVxuICAgIGFwcC51c2UodGhpcy5jb25maWcuZ3JhcGhRTFBhdGgsIGFsbG93Q3Jvc3NEb21haW4odGhpcy5wYXJzZVNlcnZlci5jb25maWcuYXBwSWQpKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCAocmVxLCBfcmVzLCBuZXh0KSA9PiB7XG4gICAgICAvLyBSYXRlIGxpbWl0IHBhdGggZm9yIGFueSBVUkwgdmFyaWFudCBvZiB0aGUgZW5kcG9pbnRcbiAgICAgIHJlcS5fZ3JhcGhRTFBhdGggPSB0aGlzLmNvbmZpZy5ncmFwaFFMUGF0aDtcbiAgICAgIG5leHQoKTtcbiAgICB9KTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBoYW5kbGVQYXJzZUhlYWRlcnMpO1xuICAgIGFwcC51c2UodGhpcy5jb25maWcuZ3JhcGhRTFBhdGgsIGhhbmRsZVBhcnNlU2Vzc2lvbik7XG4gICAgdGhpcy5hcHBseVJlcXVlc3RDb250ZXh0TWlkZGxld2FyZShhcHAsIHRoaXMucGFyc2VTZXJ2ZXIuY29uZmlnKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBoYW5kbGVQYXJzZUVycm9ycyk7XG4gICAgYXBwLnVzZShcbiAgICAgIHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLFxuICAgICAgZ3JhcGhxbFVwbG9hZEV4cHJlc3Moe1xuICAgICAgICBtYXhGaWxlU2l6ZTogdGhpcy5fdHJhbnNmb3JtTWF4VXBsb2FkU2l6ZVRvQnl0ZXMoXG4gICAgICAgICAgdGhpcy5wYXJzZVNlcnZlci5jb25maWcubWF4VXBsb2FkU2l6ZSB8fCAnMjBtYidcbiAgICAgICAgKSxcbiAgICAgIH0pXG4gICAgKTtcbiAgICBhcHAudXNlKHRoaXMuY29uZmlnLmdyYXBoUUxQYXRoLCBleHByZXNzLmpzb24oKSwgYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICBjb25zdCBzZXJ2ZXIgPSBhd2FpdCB0aGlzLl9nZXRTZXJ2ZXIoKTtcbiAgICAgIHJldHVybiBzZXJ2ZXIocmVxLCByZXMsIG5leHQpO1xuICAgIH0pO1xuICB9XG5cbiAgYXBwbHlQbGF5Z3JvdW5kKGFwcCkge1xuICAgIGlmICghYXBwIHx8ICFhcHAuZ2V0KSB7XG4gICAgICByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhbiBFeHByZXNzLmpzIGFwcCBpbnN0YW5jZSEnKTtcbiAgICB9XG5cbiAgICBhcHAuZ2V0KFxuICAgICAgdGhpcy5jb25maWcucGxheWdyb3VuZFBhdGggfHxcbiAgICAgIHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGEgY29uZmlnLnBsYXlncm91bmRQYXRoIHRvIGFwcGx5UGxheWdyb3VuZCEnKSxcbiAgICAgIChfcmVxLCByZXMpID0+IHtcbiAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ3RleHQvaHRtbCcpO1xuICAgICAgICByZXMud3JpdGUoXG4gICAgICAgICAgYDxkaXYgaWQ9XCJzYW5kYm94XCIgc3R5bGU9XCJwb3NpdGlvbjphYnNvbHV0ZTt0b3A6MDtyaWdodDowO2JvdHRvbTowO2xlZnQ6MFwiPjwvZGl2PlxuICAgICAgICAgIDxzY3JpcHQgc3JjPVwiaHR0cHM6Ly9lbWJlZGRhYmxlLXNhbmRib3guY2RuLmFwb2xsb2dyYXBocWwuY29tL19sYXRlc3QvZW1iZWRkYWJsZS1zYW5kYm94LnVtZC5wcm9kdWN0aW9uLm1pbi5qc1wiPjwvc2NyaXB0PlxuICAgICAgICAgIDxzY3JpcHQ+XG4gICAgICAgICAgIG5ldyB3aW5kb3cuRW1iZWRkZWRTYW5kYm94KHtcbiAgICAgICAgICAgICB0YXJnZXQ6IFwiI3NhbmRib3hcIixcbiAgICAgICAgICAgICBlbmRwb2ludElzRWRpdGFibGU6IGZhbHNlLFxuICAgICAgICAgICAgIGluaXRpYWxFbmRwb2ludDogJHtKU09OLnN0cmluZ2lmeSh0aGlzLmNvbmZpZy5ncmFwaFFMUGF0aCl9LFxuICAgICAgICAgICAgIGhhbmRsZVJlcXVlc3Q6IChlbmRwb2ludFVybCwgb3B0aW9ucykgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gZmV0Y2goZW5kcG9pbnRVcmwsIHtcbiAgICAgICAgICAgICAgICAuLi5vcHRpb25zLFxuICAgICAgICAgICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAgICAgICAgICAgLi4ub3B0aW9ucy5oZWFkZXJzLFxuICAgICAgICAgICAgICAgICAgICAnWC1QYXJzZS1BcHBsaWNhdGlvbi1JZCc6ICR7SlNPTi5zdHJpbmdpZnkodGhpcy5wYXJzZVNlcnZlci5jb25maWcuYXBwSWQpfSxcbiAgICAgICAgICAgICAgICAgICAgJ1gtUGFyc2UtTWFzdGVyLUtleSc6ICR7SlNPTi5zdHJpbmdpZnkodGhpcy5wYXJzZVNlcnZlci5jb25maWcubWFzdGVyS2V5KX0sXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgIH0pO1xuICAgICAgICAgICAvLyBhZHZhbmNlZCBvcHRpb25zOiBodHRwczovL3d3dy5hcG9sbG9ncmFwaHFsLmNvbS9kb2NzL3N0dWRpby9leHBsb3Jlci9zYW5kYm94I2VtYmVkZGluZy1zYW5kYm94XG4gICAgICAgICAgPC9zY3JpcHQ+YFxuICAgICAgICApO1xuICAgICAgICByZXMuZW5kKCk7XG4gICAgICB9XG4gICAgKTtcbiAgfVxuXG4gIHNldEdyYXBoUUxDb25maWcoZ3JhcGhRTENvbmZpZzogUGFyc2VHcmFwaFFMQ29uZmlnKTogUHJvbWlzZSB7XG4gICAgcmV0dXJuIHRoaXMucGFyc2VHcmFwaFFMQ29udHJvbGxlci51cGRhdGVHcmFwaFFMQ29uZmlnKGdyYXBoUUxDb25maWcpO1xuICB9XG59XG5cbmV4cG9ydCB7IFBhcnNlR3JhcGhRTFNlcnZlciB9O1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxJQUFBQSxxQkFBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsT0FBQSxHQUFBRCxPQUFBO0FBQ0EsSUFBQUUsUUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsU0FBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksU0FBQSxHQUFBTCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUssUUFBQSxHQUFBTCxPQUFBO0FBQ0EsSUFBQU0sWUFBQSxHQUFBTixPQUFBO0FBQ0EsSUFBQU8sa0JBQUEsR0FBQVIsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFRLE9BQUEsR0FBQVQsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFTLG1CQUFBLEdBQUFULE9BQUE7QUFDQSxJQUFBVSxvQkFBQSxHQUFBVixPQUFBO0FBQ0EsSUFBQVcsdUJBQUEsR0FBQUMsdUJBQUEsQ0FBQVosT0FBQTtBQUNBLElBQUFhLGdCQUFBLEdBQUFiLE9BQUE7QUFBNkUsU0FBQVksd0JBQUFFLENBQUEsRUFBQUMsQ0FBQSw2QkFBQUMsT0FBQSxNQUFBQyxDQUFB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