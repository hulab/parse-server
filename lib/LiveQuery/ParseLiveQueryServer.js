"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseLiveQueryServer = void 0;
var _tv = _interopRequireDefault(require("tv4"));
var _node = _interopRequireDefault(require("parse/node"));
var _Subscription = require("./Subscription");
var _Client = require("./Client");
var _ParseWebSocketServer = require("./ParseWebSocketServer");
var _logger = _interopRequireDefault(require("../logger"));
var _RequestSchema = _interopRequireDefault(require("./RequestSchema"));
var _QueryTools = require("./QueryTools");
var _ParsePubSub = require("./ParsePubSub");
var _SchemaController = _interopRequireDefault(require("../Controllers/SchemaController"));
var _lodash = _interopRequireDefault(require("lodash"));
var _crypto = require("crypto");
var _triggers = require("../triggers");
var _Auth = require("../Auth");
var _Controllers = require("../Controllers");
var _Config = _interopRequireDefault(require("../Config"));
var _lruCache = require("lru-cache");
var _UsersRouter = _interopRequireDefault(require("../Routers/UsersRouter"));
var _DatabaseController = _interopRequireDefault(require("../Controllers/DatabaseController"));
var _util = require("util");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// @ts-ignore

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)

  // The subscriber we use to get object update from publisher

  constructor(server, config = {}, parseServerConfig = {}) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();
    this.config = config;
    config.appId = config.appId || _node.default.applicationId;
    config.masterKey = config.masterKey || _node.default.masterKey;

    // Store keys, convert obj to map
    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();
    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }
    _logger.default.verbose('Support key pairs', this.keyPairs);

    // Initialize Parse
    _node.default.Object.disableSingleInstance();
    const serverURL = config.serverURL || _node.default.serverURL;
    _node.default.serverURL = serverURL;
    _node.default.initialize(config.appId, _node.default.javaScriptKey, config.masterKey);

    // The cache controller is a proper cache controller
    // with access to User and Roles
    this.cacheController = (0, _Controllers.getCacheController)(parseServerConfig);
    config.cacheTimeout = config.cacheTimeout || 5 * 1000; // 5s

    // This auth cache stores the promises for each auth resolution.
    // The main benefit is to be able to reuse the same user / session token resolution.
    this.authCache = new _lruCache.LRUCache({
      max: 500,
      // 500 concurrent
      ttl: config.cacheTimeout
    });
    // Initialize websocket server
    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config);
    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    if (!this.subscriber.connect) {
      this.connect();
    }
  }
  async connect() {
    if (this.subscriber.isOpen) {
      return;
    }
    if (typeof this.subscriber.connect === 'function') {
      await Promise.resolve(this.subscriber.connect());
    } else {
      this.subscriber.isOpen = true;
    }
    this._createSubscribers();
  }
  async shutdown() {
    if (this.subscriber.isOpen) {
      await Promise.all([...[...this.clients.values()].map(client => client.parseWebSocket.ws.close()), this.parseWebSocketServer.close?.(), ...Array.from(this.subscriber.subscriptions?.keys() || []).map(key => this.subscriber.unsubscribe(key)), this.subscriber.close?.()]);
    }
    if (typeof this.subscriber.close === 'function') {
      try {
        await this.subscriber.close();
      } catch (err) {
        _logger.default.error('PubSubAdapter error on shutdown', {
          error: err
        });
      }
    } else {
      this.subscriber.isOpen = false;
    }
  }
  _createSubscribers() {
    const messageRecieved = (channel, messageStr) => {
      _logger.default.verbose('Subscribe message %j', messageStr);
      let message;
      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger.default.error('unable to parse message', messageStr, e);
        return;
      }
      if (channel === _node.default.applicationId + 'clearCache') {
        this._clearCachedRoles(message.userId);
        return;
      }
      this._inflateParseObject(message);
      if (channel === _node.default.applicationId + 'afterSave') {
        this._onAfterSave(message);
      } else if (channel === _node.default.applicationId + 'afterDelete') {
        this._onAfterDelete(message);
      } else {
        _logger.default.error('Get message %s from unknown channel %j', message, channel);
      }
    };
    this.subscriber.on('message', (channel, messageStr) => messageRecieved(channel, messageStr));
    for (const field of ['afterSave', 'afterDelete', 'clearCache']) {
      const channel = `${_node.default.applicationId}${field}`;
      this.subscriber.subscribe(channel, messageStr => messageRecieved(channel, messageStr));
    }
  }

  // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.
  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;
    _UsersRouter.default.removeHiddenProperties(currentParseObject);
    let className = currentParseObject.className;
    let parseObject = new _node.default.Object(className);
    parseObject._finishFetch(currentParseObject);
    message.currentParseObject = parseObject;
    // Inflate original object
    const originalParseObject = message.originalParseObject;
    if (originalParseObject) {
      _UsersRouter.default.removeHiddenProperties(originalParseObject);
      className = originalParseObject.className;
      parseObject = new _node.default.Object(className);
      parseObject._finishFetch(originalParseObject);
      message.originalParseObject = parseObject;
    }
  }

  // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.
  async _onAfterDelete(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterDelete is triggered');
    let deletedParseObject = message.currentParseObject.toJSON();
    const classLevelPermissions = message.classLevelPermissions;
    const className = deletedParseObject.className;
    _logger.default.verbose('ClassName: %j | ObjectId: %s', className, deletedParseObject.id);
    _logger.default.verbose('Current client number : %d', this.clients.size);
    const classSubscriptions = this.subscriptions.get(className);
    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);
      return;
    }
    for (const subscription of classSubscriptions.values()) {
      let isSubscriptionMatched;
      try {
        isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);
      } catch (e) {
        _logger.default.error(`Failed matching subscription for class ${className}: ${e.message}`);
        continue;
      }
      if (!isSubscriptionMatched) {
        continue;
      }
      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);
        if (typeof client === 'undefined') {
          continue;
        }
        requestIds.forEach(async requestId => {
          // Deep-clone shared object so each concurrent callback works on its own copy
          let localDeletedParseObject = JSON.parse(JSON.stringify(deletedParseObject));
          const acl = message.currentParseObject.getACL();
          // Check CLP
          const op = this._getCLPOperation(subscription.query);
          let res = {};
          try {
            const matchesCLP = await this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op);
            if (matchesCLP === false) {
              return null;
            }
            const isMatched = await this._matchesACL(acl, client, requestId);
            if (!isMatched) {
              return null;
            }
            res = {
              event: 'delete',
              sessionToken: client.sessionToken,
              object: localDeletedParseObject,
              clients: this.clients.size,
              subscriptions: this.subscriptions.size,
              useMasterKey: client.hasMasterKey,
              installationId: client.installationId,
              sendEvent: true
            };
            const trigger = (0, _triggers.getTrigger)(className, 'afterEvent', _node.default.applicationId);
            if (trigger) {
              const auth = await this.getAuthFromClient(client, requestId);
              if (auth && auth.user) {
                res.user = auth.user;
              }
              if (res.object) {
                res.object = _node.default.Object.fromJSON(res.object);
              }
              await (0, _triggers.runTrigger)(trigger, `afterEvent.${className}`, res, auth);
            }
            if (!res.sendEvent) {
              return;
            }
            if (res.object && typeof res.object.toJSON === 'function') {
              localDeletedParseObject = (0, _triggers.toJSONwithObjects)(res.object, res.object.className || className);
            }
            res.object = localDeletedParseObject;
            await this._filterSensitiveData(classLevelPermissions, res, client, requestId, op, subscription.query);
            client.pushDelete(requestId, res.object);
          } catch (e) {
            const error = (0, _triggers.resolveError)(e);
            _Client.Client.pushError(client.parseWebSocket, error.code, error.message, false, requestId);
            _logger.default.error(`Failed running afterLiveQueryEvent on class ${className} for event ${res.event} with session ${res.sessionToken} with:\n Error: ` + JSON.stringify(error));
          }
        });
      }
    }
  }

  // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.
  async _onAfterSave(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterSave is triggered');
    let originalParseObject = null;
    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }
    const classLevelPermissions = message.classLevelPermissions;
    let currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;
    _logger.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);
    _logger.default.verbose('Current client number : %d', this.clients.size);
    const classSubscriptions = this.subscriptions.get(className);
    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);
      return;
    }
    for (const subscription of classSubscriptions.values()) {
      let isOriginalSubscriptionMatched;
      let isCurrentSubscriptionMatched;
      try {
        isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);
        isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);
      } catch (e) {
        _logger.default.error(`Failed matching subscription for class ${className}: ${e.message}`);
        continue;
      }
      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);
        if (typeof client === 'undefined') {
          continue;
        }
        requestIds.forEach(async requestId => {
          // Deep-clone shared objects so each concurrent callback works on its own copy.
          // Without cloning, _filterSensitiveData's in-place field deletion and afterEvent
          // trigger modifications corrupt the shared state across concurrent subscribers.
          let localCurrentParseObject = JSON.parse(JSON.stringify(currentParseObject));
          let localOriginalParseObject = originalParseObject ? JSON.parse(JSON.stringify(originalParseObject)) : null;
          // Set orignal ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let originalACLCheckingPromise;
          if (!isOriginalSubscriptionMatched) {
            originalACLCheckingPromise = Promise.resolve(false);
          } else {
            let originalACL;
            if (message.originalParseObject) {
              originalACL = message.originalParseObject.getACL();
            }
            originalACLCheckingPromise = this._matchesACL(originalACL, client, requestId);
          }
          // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let currentACLCheckingPromise;
          let res = {};
          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }
          try {
            const op = this._getCLPOperation(subscription.query);
            const matchesCLP = await this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op);
            if (matchesCLP === false) {
              return;
            }
            const [isOriginalMatched, isCurrentMatched] = await Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]);
            _logger.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', localOriginalParseObject, localCurrentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash);
            // Decide event type
            let type;
            if (isOriginalMatched && isCurrentMatched) {
              type = 'update';
            } else if (isOriginalMatched && !isCurrentMatched) {
              type = 'leave';
            } else if (!isOriginalMatched && isCurrentMatched) {
              if (localOriginalParseObject) {
                type = 'enter';
              } else {
                type = 'create';
              }
            } else {
              return null;
            }
            const watchFieldsChanged = this._checkWatchFields(client, requestId, message);
            if (!watchFieldsChanged && (type === 'update' || type === 'create')) {
              return;
            }
            // A `leave` or `enter` transition can be caused either by the object's
            // query match changing (the subscriber keeps read access) or by the
            // subscriber's ACL read access being revoked or granted in the same save.
            // In the access-change case the subscriber is not authorized to read the
            // object state that triggered the transition, so that state must not be
            // sent over the channel. (CLP read denial is handled earlier by
            // `_matchesCLP`, which skips the event entirely.)
            if (type === 'leave') {
              // The post-update object is readable on a query-mismatch leave but not
              // on an ACL-loss leave. Only send the post-update body when the
              // subscriber can still read the current object; otherwise fall back to
              // the last authorized (original) state, which still carries the objectId.
              const currentReadable = isCurrentSubscriptionMatched ? false : await this._matchesACL(message.currentParseObject.getACL(), client, requestId);
              if (!currentReadable) {
                localCurrentParseObject = JSON.parse(JSON.stringify(localOriginalParseObject));
              }
            } else if (type === 'enter') {
              // The pre-update object was readable on a query-match-gain enter but not
              // on an ACL-grant enter. Only send the pre-update body as `original`
              // when the subscriber could read the original object.
              const originalReadable = isOriginalSubscriptionMatched ? false : await this._matchesACL(message.originalParseObject.getACL(), client, requestId);
              if (!originalReadable) {
                localOriginalParseObject = null;
              }
            }
            res = {
              event: type,
              sessionToken: client.sessionToken,
              object: localCurrentParseObject,
              original: localOriginalParseObject,
              clients: this.clients.size,
              subscriptions: this.subscriptions.size,
              useMasterKey: client.hasMasterKey,
              installationId: client.installationId,
              sendEvent: true
            };
            const trigger = (0, _triggers.getTrigger)(className, 'afterEvent', _node.default.applicationId);
            if (trigger) {
              if (res.object) {
                res.object = _node.default.Object.fromJSON(res.object);
              }
              if (res.original) {
                res.original = _node.default.Object.fromJSON(res.original);
              }
              const auth = await this.getAuthFromClient(client, requestId);
              if (auth && auth.user) {
                res.user = auth.user;
              }
              await (0, _triggers.runTrigger)(trigger, `afterEvent.${className}`, res, auth);
            }
            if (!res.sendEvent) {
              return;
            }
            if (res.object && typeof res.object.toJSON === 'function') {
              localCurrentParseObject = (0, _triggers.toJSONwithObjects)(res.object, res.object.className || className);
            }
            if (res.original && typeof res.original.toJSON === 'function') {
              localOriginalParseObject = (0, _triggers.toJSONwithObjects)(res.original, res.original.className || className);
            }
            res.object = localCurrentParseObject;
            res.original = localOriginalParseObject;
            await this._filterSensitiveData(classLevelPermissions, res, client, requestId, op, subscription.query);
            const functionName = 'push' + res.event.charAt(0).toUpperCase() + res.event.slice(1);
            if (client[functionName]) {
              client[functionName](requestId, res.object, res.original ?? null);
            }
          } catch (e) {
            const error = (0, _triggers.resolveError)(e);
            _Client.Client.pushError(client.parseWebSocket, error.code, error.message, false, requestId);
            _logger.default.error(`Failed running afterLiveQueryEvent on class ${className} for event ${res.event} with session ${res.sessionToken} with:\n Error: ` + JSON.stringify(error));
          }
        });
      }
    }
  }
  _onConnect(parseWebsocket) {
    parseWebsocket.on('message', request => {
      if (typeof request === 'string') {
        try {
          request = JSON.parse(request);
        } catch (e) {
          _logger.default.error('unable to parse request', request, e);
          return;
        }
      }
      _logger.default.verbose('Request: %j', request);

      // Check whether this request is a valid request, return error directly if not
      if (!_tv.default.validate(request, _RequestSchema.default['general']) || !_tv.default.validate(request, _RequestSchema.default[request.op])) {
        _Client.Client.pushError(parseWebsocket, 1, _tv.default.error.message);
        _logger.default.error('Connect message error %s', _tv.default.error.message);
        return;
      }
      switch (request.op) {
        case 'connect':
          this._handleConnect(parseWebsocket, request);
          break;
        case 'subscribe':
          this._handleSubscribe(parseWebsocket, request);
          break;
        case 'update':
          this._handleUpdateSubscription(parseWebsocket, request);
          break;
        case 'unsubscribe':
          this._handleUnsubscribe(parseWebsocket, request);
          break;
        default:
          _Client.Client.pushError(parseWebsocket, 3, 'Get unknown operation');
          _logger.default.error('Get unknown operation', request.op);
      }
    });
    parseWebsocket.on('disconnect', () => {
      _logger.default.info(`Client disconnect: ${parseWebsocket.clientId}`);
      const clientId = parseWebsocket.clientId;
      if (!this.clients.has(clientId)) {
        (0, _triggers.runLiveQueryEventHandlers)({
          event: 'ws_disconnect_error',
          clients: this.clients.size,
          subscriptions: this.subscriptions.size,
          error: `Unable to find client ${clientId}`
        });
        _logger.default.error(`Can not find client ${clientId} on disconnect`);
        return;
      }

      // Delete client
      const client = this.clients.get(clientId);
      this.clients.delete(clientId);

      // Delete client from subscriptions
      for (const [requestId, subscriptionInfo] of _lodash.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId);

        // If there is no client which is subscribing this subscription, remove it from subscriptions
        const classSubscriptions = this.subscriptions.get(subscription.className);
        if (classSubscriptions) {
          if (!subscription.hasSubscribingClient()) {
            classSubscriptions.delete(subscription.hash);
          }
          // If there is no subscriptions under this class, remove it from subscriptions
          if (classSubscriptions.size === 0) {
            this.subscriptions.delete(subscription.className);
          }
        }
      }
      _logger.default.verbose('Current clients %d', this.clients.size);
      _logger.default.verbose('Current subscriptions %d', this.subscriptions.size);
      (0, _triggers.runLiveQueryEventHandlers)({
        event: 'ws_disconnect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size,
        useMasterKey: client.hasMasterKey,
        installationId: client.installationId,
        sessionToken: client.sessionToken
      });
    });
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'ws_connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }
  _validateQueryConstraints(where) {
    if (typeof where !== 'object' || where === null) {
      return;
    }
    for (const op of ['$or', '$and', '$nor']) {
      if (where[op] !== undefined && !Array.isArray(where[op])) {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `${op} must be an array`);
      }
      if (Array.isArray(where[op])) {
        where[op].forEach(subQuery => {
          this._validateQueryConstraints(subQuery);
        });
      }
    }
    for (const key of Object.keys(where)) {
      const constraint = where[key];
      if (typeof constraint === 'object' && constraint !== null) {
        if (constraint.$regex !== undefined) {
          const regex = constraint.$regex;
          const isRegExpLike = regex !== null && typeof regex === 'object' && typeof regex.source === 'string' && typeof regex.flags === 'string';
          if (typeof regex !== 'string' && !isRegExpLike) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, 'Invalid regular expression: $regex must be a string or RegExp');
          }
          const pattern = isRegExpLike ? regex.source : regex;
          const flags = isRegExpLike ? regex.flags : constraint.$options || '';
          try {
            new RegExp(pattern, flags);
          } catch (e) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Invalid regular expression: ${e.message}`);
          }
        }
      }
    }
  }
  _matchesSubscription(parseObject, subscription) {
    // Object is undefined or null, not match
    if (!parseObject) {
      return false;
    }
    return (0, _QueryTools.matchesQuery)(structuredClone(parseObject), subscription.query);
  }
  async _clearCachedRoles(userId) {
    try {
      const validTokens = await new _node.default.Query(_node.default.Session).equalTo('user', _node.default.User.createWithoutData(userId)).find({
        useMasterKey: true
      });
      await Promise.all(validTokens.map(async token => {
        const sessionToken = token.get('sessionToken');
        const authPromise = this.authCache.get(sessionToken);
        if (!authPromise) {
          return;
        }
        const [auth1, auth2] = await Promise.all([authPromise, (0, _Auth.getAuthForSessionToken)({
          cacheController: this.cacheController,
          sessionToken
        })]);
        auth1.auth?.clearRoleCache(sessionToken);
        auth2.auth?.clearRoleCache(sessionToken);
        this.authCache.delete(sessionToken);
      }));
    } catch (e) {
      _logger.default.verbose(`Could not clear role cache. ${e}`);
    }
  }
  getAuthForSessionToken(sessionToken) {
    if (!sessionToken) {
      return Promise.resolve({});
    }
    const fromCache = this.authCache.get(sessionToken);
    if (fromCache) {
      return fromCache;
    }
    const authPromise = (0, _Auth.getAuthForSessionToken)({
      cacheController: this.cacheController,
      sessionToken: sessionToken
    }).then(auth => {
      return {
        auth,
        userId: auth && auth.user && auth.user.id
      };
    }).catch(error => {
      // There was an error with the session token
      const result = {};
      if (error && error.code === _node.default.Error.INVALID_SESSION_TOKEN) {
        result.error = error;
        this.authCache.set(sessionToken, Promise.resolve(result), {
          ttl: this.config.cacheTimeout
        });
      } else {
        this.authCache.delete(sessionToken);
      }
      return result;
    });
    this.authCache.set(sessionToken, authPromise);
    return authPromise;
  }
  async _matchesCLP(classLevelPermissions, object, client, requestId, op) {
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let userId;
    if (typeof subscriptionInfo !== 'undefined') {
      // Fall back to the connect-frame token, the same way `_matchesACL`,
      // `getAuthFromClient` and `_filterSensitiveData` already do. The subscribe
      // frame's session token is optional, so resolving only it would evaluate the
      // CLP against an anonymous identity while the ACL check authorized the read
      // against the connected user.
      const result = await this.getAuthForSessionToken(subscriptionInfo.sessionToken || client.sessionToken);
      userId = result.userId;
      if (userId) {
        aclGroup.push(userId);
        // Read per call rather than caching on the instance: the whole app config
        // can be replaced at runtime through the `Parse.Server` setter.
        const appConfig = _Config.default.get(this.config.appId);
        aclGroup.push(...(await this._rolesForCLPOperation(classLevelPermissions, result.auth, op, appConfig)));
      }
    }
    await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
    // Enforce pointer permissions that validatePermission defers.
    // Returns false to silently skip the event (like ACL), rather than
    // throwing which would push errors to the client and log noise.
    if (!client.hasMasterKey && !_SchemaController.default.testPointerPermissions(classLevelPermissions, aclGroup, op, userId, field => typeof object.get === 'function' ? object.get(field) : object[field])) {
      return false;
    }
  }

  // `addProtectedFields` reads role-scoped `protectedFields` groups from
  // `Auth.userRoles`, which stays empty unless the roles are explicitly loaded.
  // Without this, every `role:` group is silently skipped and LiveQuery would
  // disclose fields that the REST path strips for the same caller. The roles are
  // only fetched when the class actually declares a `role:` group, so classes
  // without one keep subscribing and receiving events without a role lookup.
  async _loadRolesForProtectedFields(classLevelPermissions, clientAuth) {
    if (typeof clientAuth?.getUserRoles !== 'function') {
      return;
    }
    const protectedFields = classLevelPermissions?.protectedFields;
    if (!protectedFields || Array.isArray(protectedFields)) {
      return;
    }
    if (!Object.keys(protectedFields).some(key => key.startsWith('role:'))) {
      return;
    }
    await clientAuth.getUserRoles();
  }

  // `SchemaController.testPermissions` matches CLP entries against the caller's
  // ACL group, so a `role:` grant only applies when the caller's roles are in that
  // group. The REST path builds the same group in `RestQuery.getUserAndRoleACL`;
  // without this LiveQuery denies `find`/`get` to legitimate role members that the
  // equivalent REST query serves.
  //
  // Honouring the grant widens what LiveQuery delivers, so it is opt-in until the
  // next major via `enableLiveQueryClassLevelPermissionRoles` (see DEPPS25). The
  // option lives on `ParseServerOptions`, which is NOT what `this.config` holds --
  // that is `liveQueryServerOptions` -- so it has to be read through `Config.get`.
  // The optional chaining is required: `Config.get` returns `undefined` for a
  // standalone LiveQuery server, whose `AppCache` is empty.
  //
  // The roles are only resolved when the operation's CLP actually declares a
  // `role:` entry, so classes that grant by `*` or by user id keep matching events
  // without a role lookup.
  async _rolesForCLPOperation(classLevelPermissions, clientAuth, op, appConfig) {
    if (!appConfig?.enableLiveQueryClassLevelPermissionRoles) {
      return [];
    }
    if (typeof clientAuth?.getUserRoles !== 'function') {
      return [];
    }
    const opPermissions = classLevelPermissions?.[op];
    if (!opPermissions || typeof opPermissions !== 'object') {
      return [];
    }
    if (!Object.keys(opPermissions).some(key => key.startsWith('role:'))) {
      return [];
    }
    return await clientAuth.getUserRoles();
  }
  async _filterSensitiveData(classLevelPermissions, res, client, requestId, op, query) {
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let clientAuth;
    if (typeof subscriptionInfo !== 'undefined') {
      // Fall back to the connect-frame token, the same way `_matchesACL` and
      // `getAuthFromClient` already do. The subscribe frame's session token is
      // optional, so resolving only it would redact against an anonymous identity
      // while the ACL check authorized the read against the connected user. That
      // mismatch skips every identity-derived `protectedFields` group
      // (`role:`, `authenticated` and `<objectId>`).
      const {
        userId,
        auth
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken || client.sessionToken);
      if (userId) {
        aclGroup.push(userId);
      }
      clientAuth = auth;
    }
    if (!client.hasMasterKey) {
      await this._loadRolesForProtectedFields(classLevelPermissions, clientAuth);
    }
    // `DatabaseController.filterSensitiveData` reads the class permissions through
    // `schema.getClassLevelPermissions(className)` and falls back to `{}` when the
    // argument does not expose that method. The LiveQuery server only ever holds
    // the serialized CLP from the published message and has no `SchemaController`
    // for the class, so passing the raw CLP silently skipped the entire
    // `userField:` block: those groups intersect against the other groups, so
    // skipping them left fields protected that the REST path returns. Wrap the CLP
    // so the helper can reach it. (`addProtectedFields` above needs no wrapper --
    // it already falls back to treating its argument as the permissions object.)
    const schema = {
      getClassLevelPermissions: () => classLevelPermissions
    };
    // Parse Server options, not LiveQuery options
    const appConfig = client.hasMasterKey ? undefined : _Config.default.get(this.config.appId);
    const filter = obj => {
      if (!obj) {
        return;
      }
      let protectedFields = classLevelPermissions?.protectedFields || [];
      if (client.hasMasterKey) {
        protectedFields = [];
      } else if (!Array.isArray(protectedFields)) {
        // Standalone server has no app config
        const database = appConfig?.database || (0, _Controllers.getDatabaseController)(this.config);
        protectedFields = database.addProtectedFields(classLevelPermissions, res.object.className, query, aclGroup, clientAuth);
      }
      return _DatabaseController.default.filterSensitiveData(client.hasMasterKey, false, aclGroup, clientAuth, op, schema, res.object.className, protectedFields, obj, appConfig?.protectedFieldsOwnerExempt);
    };
    res.object = filter(res.object);
    res.original = filter(res.original);
  }
  _getCLPOperation(query) {
    return typeof query === 'object' && Object.keys(query).length == 1 && typeof query.objectId === 'string' ? 'get' : 'find';
  }
  async _verifyACL(acl, token) {
    if (!token) {
      return false;
    }
    const {
      auth,
      userId
    } = await this.getAuthForSessionToken(token);

    // Getting the session token failed
    // This means that no additional auth is available
    // At this point, just bail out as no additional visibility can be inferred.
    if (!auth || !userId) {
      return false;
    }
    const isSubscriptionSessionTokenMatched = acl.getReadAccess(userId);
    if (isSubscriptionSessionTokenMatched) {
      return true;
    }

    // Check if the user has any roles that match the ACL
    return Promise.resolve().then(async () => {
      // Resolve false right away if the acl doesn't have any roles
      const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith('role:'));
      if (!acl_has_roles) {
        return false;
      }
      const roleNames = await auth.getUserRoles();
      // Finally, see if any of the user's roles allow them read access
      for (const role of roleNames) {
        // We use getReadAccess as `role` is in the form `role:roleName`
        if (acl.getReadAccess(role)) {
          return true;
        }
      }
      return false;
    }).catch(() => {
      return false;
    });
  }
  async getAuthFromClient(client, requestId, sessionToken) {
    const getSessionFromClient = () => {
      const subscriptionInfo = client.getSubscriptionInfo(requestId);
      if (typeof subscriptionInfo === 'undefined') {
        return client.sessionToken;
      }
      return subscriptionInfo.sessionToken || client.sessionToken;
    };
    if (!sessionToken) {
      sessionToken = getSessionFromClient();
    }
    if (!sessionToken) {
      return;
    }
    const {
      auth
    } = await this.getAuthForSessionToken(sessionToken);
    return auth;
  }
  _checkWatchFields(client, requestId, message) {
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const watch = subscriptionInfo?.watch;
    if (!watch) {
      return true;
    }
    const object = message.currentParseObject;
    const original = message.originalParseObject;
    return watch.some(field => !(0, _util.isDeepStrictEqual)(object.get(field), original?.get(field)));
  }
  async _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return true;
    }
    // Check subscription sessionToken matches ACL first
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    if (typeof subscriptionInfo === 'undefined') {
      return false;
    }
    const subscriptionToken = subscriptionInfo.sessionToken;
    const clientSessionToken = client.sessionToken;
    if (await this._verifyACL(acl, subscriptionToken)) {
      return true;
    }
    if (await this._verifyACL(acl, clientSessionToken)) {
      return true;
    }
    return false;
  }
  async _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');
      _logger.default.error('Key in request is not valid');
      return;
    }
    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);
    const clientId = (0, _crypto.randomUUID)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey, request.sessionToken, request.installationId);
    try {
      const req = {
        client,
        event: 'connect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size,
        sessionToken: request.sessionToken,
        useMasterKey: client.hasMasterKey,
        installationId: request.installationId,
        user: undefined
      };
      const trigger = (0, _triggers.getTrigger)('@Connect', 'beforeConnect', _node.default.applicationId);
      if (trigger) {
        const auth = await this.getAuthFromClient(client, request.requestId, req.sessionToken);
        if (auth && auth.user) {
          req.user = auth.user;
        }
        await (0, _triggers.runTrigger)(trigger, `beforeConnect.@Connect`, req, auth);
      }
      parseWebsocket.clientId = clientId;
      this.clients.set(parseWebsocket.clientId, client);
      _logger.default.info(`Create new client: ${parseWebsocket.clientId}`);
      client.pushConnect();
      (0, _triggers.runLiveQueryEventHandlers)(req);
    } catch (e) {
      const error = (0, _triggers.resolveError)(e);
      _Client.Client.pushError(parseWebsocket, error.code, error.message, false);
      _logger.default.error(`Failed running beforeConnect for session ${request.sessionToken} with:\n Error: ` + JSON.stringify(error));
    }
  }
  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has('masterKey')) {
      return false;
    }
    if (!request || !Object.prototype.hasOwnProperty.call(request, 'masterKey')) {
      return false;
    }
    return request.masterKey === validKeyPairs.get('masterKey');
  }
  _validateKeys(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0) {
      return true;
    }
    let isValid = false;
    for (const [key, secret] of validKeyPairs) {
      if (!request[key] || request[key] !== secret) {
        continue;
      }
      isValid = true;
      break;
    }
    return isValid;
  }
  async _handleSubscribe(parseWebsocket, request) {
    // If we can not find this client, return error to client
    if (!Object.prototype.hasOwnProperty.call(parseWebsocket, 'clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before subscribing');
      _logger.default.error('Can not find this client, make sure you connect to server before subscribing');
      return;
    }
    const client = this.clients.get(parseWebsocket.clientId);
    const className = request.query.className;
    let authCalled = false;
    let clientAuth;
    try {
      const trigger = (0, _triggers.getTrigger)(className, 'beforeSubscribe', _node.default.applicationId);
      if (trigger) {
        const auth = await this.getAuthFromClient(client, request.requestId, request.sessionToken);
        authCalled = true;
        clientAuth = auth;
        if (auth && auth.user) {
          request.user = auth.user;
        }
        const parseQuery = new _node.default.Query(className);
        parseQuery.withJSON(request.query);
        request.query = parseQuery;
        await (0, _triggers.runTrigger)(trigger, `beforeSubscribe.${className}`, request, auth);
        const query = request.query.toJSON();
        request.query = query;
      }
      if (className === '_Session') {
        if (!authCalled) {
          const auth = await this.getAuthFromClient(client, request.requestId, request.sessionToken);
          clientAuth = auth;
          if (auth && auth.user) {
            request.user = auth.user;
          }
        }
        if (request.user) {
          request.query.where.user = request.user.toPointer();
        } else if (!request.master) {
          _Client.Client.pushError(parseWebsocket, _node.default.Error.INVALID_SESSION_TOKEN, 'Invalid session token', false, request.requestId);
          return;
        }
      }
      // Validate query condition depth
      const appConfig = _Config.default.get(this.config.appId);
      if (!client.hasMasterKey) {
        const rc = appConfig.requestComplexity;
        if (rc && rc.queryDepth !== -1) {
          const maxDepth = rc.queryDepth;
          const checkDepth = (node, depth) => {
            if (depth > maxDepth) {
              throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Query condition nesting depth exceeds maximum allowed depth of ${maxDepth}`);
            }
            if (node === null || typeof node !== 'object') {
              return;
            }
            if (Array.isArray(node)) {
              for (const item of node) {
                checkDepth(item, depth);
              }
              return;
            }
            // Descend into every value so that logical operators ($or/$and/$nor)
            // nested under field-level operators (e.g. $elemMatch, $not) or plain
            // field names are still counted. Only logical operators increase the
            // depth, which preserves the documented meaning of `queryDepth`.
            for (const key of Object.keys(node)) {
              const isLogical = key === '$or' || key === '$and' || key === '$nor';
              if (isLogical && !Array.isArray(node[key])) {
                throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `${key} must be an array`);
              }
              checkDepth(node[key], isLogical ? depth + 1 : depth);
            }
          };
          checkDepth(request.query.where, 0);
        }
      }

      // Validate allowRegex
      if (!client.hasMasterKey) {
        const rc = appConfig.requestComplexity;
        if (rc && rc.allowRegex === false) {
          const checkRegex = where => {
            if (typeof where !== 'object' || where === null) {
              return;
            }
            for (const key of Object.keys(where)) {
              const constraint = where[key];
              if (typeof constraint === 'object' && constraint !== null && constraint.$regex !== undefined) {
                throw new _node.default.Error(_node.default.Error.INVALID_QUERY, '$regex operator is not allowed');
              }
            }
            for (const op of ['$or', '$and', '$nor']) {
              if (Array.isArray(where[op])) {
                for (const subQuery of where[op]) {
                  checkRegex(subQuery);
                }
              }
            }
          };
          checkRegex(request.query.where);
        }
      }

      // Check CLP for subscribe operation
      const schemaController = await appConfig.database.loadSchema();
      const classLevelPermissions = schemaController.getClassLevelPermissions(className);
      const op = this._getCLPOperation(request.query);
      const aclGroup = ['*'];
      if (!authCalled) {
        const auth = await this.getAuthFromClient(client, request.requestId, request.sessionToken);
        authCalled = true;
        clientAuth = auth;
        if (auth && auth.user) {
          request.user = auth.user;
          aclGroup.push(auth.user.id);
        }
      } else if (request.user) {
        aclGroup.push(request.user.id);
      }
      if (request.user) {
        aclGroup.push(...(await this._rolesForCLPOperation(classLevelPermissions, clientAuth, op, appConfig)));
      }
      await _SchemaController.default.validatePermission(classLevelPermissions, className, aclGroup, op);

      // Check protected fields in WHERE clause and WATCH parameter
      if (!client.hasMasterKey) {
        await this._loadRolesForProtectedFields(classLevelPermissions, clientAuth);
        // `clientAuth` is undefined only when no session token was supplied on
        // either frame, in which case a `beforeSubscribe` trigger is the only way
        // `request.user` can be set. There is no session to resolve roles from for
        // such a trigger-assigned user, so `role:` groups cannot be applied to it.
        const auth = request.user ? clientAuth || {
          user: request.user,
          userRoles: []
        } : {};
        const protectedFields = appConfig.database.addProtectedFields(classLevelPermissions, className, request.query.where, aclGroup, auth) || [];
        if (protectedFields.length > 0 && request.query.where) {
          const checkWhere = where => {
            if (typeof where !== 'object' || where === null) {
              return;
            }
            for (const whereKey of Object.keys(where)) {
              const rootField = whereKey.split('.')[0];
              if (protectedFields.includes(whereKey) || protectedFields.includes(rootField)) {
                throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'Permission denied');
              }
            }
            for (const op of ['$or', '$and', '$nor']) {
              if (where[op] !== undefined && !Array.isArray(where[op])) {
                throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `${op} must be an array`);
              }
              if (Array.isArray(where[op])) {
                where[op].forEach(subQuery => checkWhere(subQuery));
              }
            }
          };
          checkWhere(request.query.where);
        }
        if (protectedFields.length > 0 && Array.isArray(request.query.watch)) {
          for (const watchField of request.query.watch) {
            const rootField = watchField.split('.')[0];
            if (protectedFields.includes(watchField) || protectedFields.includes(rootField)) {
              throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, 'Permission denied');
            }
          }
        }
      }

      // Validate regex patterns in the subscription query
      this._validateQueryConstraints(request.query.where);

      // If this client already has a subscription registered under this
      // requestId, replace it by tearing down the previous subscription before
      // creating the new one. The client-side metadata map is keyed only by
      // requestId, so a duplicate `subscribe` frame would otherwise overwrite it
      // while the previous Subscription stays in the server-wide map, leaking it
      // for the lifetime of the process (disconnect cleanup only walks the
      // surviving client metadata and never reaches the orphaned subscription).
      const previousSubscriptionInfo = client.getSubscriptionInfo(request.requestId);
      if (previousSubscriptionInfo) {
        const previousSubscription = previousSubscriptionInfo.subscription;
        previousSubscription.deleteClientSubscription(parseWebsocket.clientId, request.requestId);
        const previousClassSubscriptions = this.subscriptions.get(previousSubscription.className);
        if (previousClassSubscriptions) {
          if (!previousSubscription.hasSubscribingClient()) {
            previousClassSubscriptions.delete(previousSubscription.hash);
          }
          if (previousClassSubscriptions.size === 0) {
            this.subscriptions.delete(previousSubscription.className);
          }
        }
      }

      // Get subscription from subscriptions, create one if necessary
      const subscriptionHash = (0, _QueryTools.queryHash)(request.query);
      // Add className to subscriptions if necessary

      if (!this.subscriptions.has(className)) {
        this.subscriptions.set(className, new Map());
      }
      const classSubscriptions = this.subscriptions.get(className);
      let subscription;
      if (classSubscriptions.has(subscriptionHash)) {
        subscription = classSubscriptions.get(subscriptionHash);
      } else {
        subscription = new _Subscription.Subscription(className, request.query.where, subscriptionHash);
        classSubscriptions.set(subscriptionHash, subscription);
      }

      // Add subscriptionInfo to client
      const subscriptionInfo = {
        subscription: subscription
      };
      // Add selected fields, sessionToken and installationId for this subscription if necessary
      if (request.query.keys) {
        subscriptionInfo.keys = Array.isArray(request.query.keys) ? request.query.keys : request.query.keys.split(',');
      }
      if (request.query.watch) {
        subscriptionInfo.watch = request.query.watch;
      }
      if (request.sessionToken) {
        subscriptionInfo.sessionToken = request.sessionToken;
      }
      client.addSubscriptionInfo(request.requestId, subscriptionInfo);

      // Add clientId to subscription
      subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);
      client.pushSubscribe(request.requestId);
      _logger.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);
      _logger.default.verbose('Current client number: %d', this.clients.size);
      (0, _triggers.runLiveQueryEventHandlers)({
        client,
        event: 'subscribe',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size,
        sessionToken: request.sessionToken,
        useMasterKey: client.hasMasterKey,
        installationId: client.installationId
      });
    } catch (e) {
      const error = (0, _triggers.resolveError)(e);
      _Client.Client.pushError(parseWebsocket, error.code, error.message, false, request.requestId);
      _logger.default.error(`Failed running beforeSubscribe on ${className} for session ${request.sessionToken} with:\n Error: ` + JSON.stringify(error));
    }
  }
  _handleUpdateSubscription(parseWebsocket, request) {
    this._handleUnsubscribe(parseWebsocket, request, false);
    this._handleSubscribe(parseWebsocket, request);
  }
  _handleUnsubscribe(parseWebsocket, request, notifyClient = true) {
    // If we can not find this client, return error to client
    if (!Object.prototype.hasOwnProperty.call(parseWebsocket, 'clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before unsubscribing');
      _logger.default.error('Can not find this client, make sure you connect to server before unsubscribing');
      return;
    }
    const requestId = request.requestId;
    const client = this.clients.get(parseWebsocket.clientId);
    if (typeof client === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find client with clientId ' + parseWebsocket.clientId + '. Make sure you connect to live query server before unsubscribing.');
      _logger.default.error('Can not find this client ' + parseWebsocket.clientId);
      return;
    }
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    if (typeof subscriptionInfo === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId + '. Make sure you subscribe to live query server before unsubscribing.');
      _logger.default.error('Can not find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId);
      return;
    }

    // Remove subscription from client
    client.deleteSubscriptionInfo(requestId);
    // Remove client from subscription
    const subscription = subscriptionInfo.subscription;
    const className = subscription.className;
    subscription.deleteClientSubscription(parseWebsocket.clientId, requestId);
    // If there is no client which is subscribing this subscription, remove it from subscriptions
    const classSubscriptions = this.subscriptions.get(className);
    if (classSubscriptions) {
      if (!subscription.hasSubscribingClient()) {
        classSubscriptions.delete(subscription.hash);
      }
      // If there is no subscriptions under this class, remove it from subscriptions
      if (classSubscriptions.size === 0) {
        this.subscriptions.delete(className);
      }
    }
    (0, _triggers.runLiveQueryEventHandlers)({
      client,
      event: 'unsubscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size,
      sessionToken: subscriptionInfo.sessionToken,
      useMasterKey: client.hasMasterKey,
      installationId: client.installationId
    });
    if (!notifyClient) {
      return;
    }
    client.pushUnsubscribe(request.requestId);
    _logger.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }
}
exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfdHYiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9ub2RlIiwiX1N1YnNjcmlwdGlvbiIsIl9DbGllbnQiLCJfUGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJfbG9nZ2VyIiwiX1JlcXVlc3RTY2hlbWEiLCJfUXVlcnlUb29scyIsIl9QYXJzZVB1YlN1YiIsIl9TY2hlbWFDb250cm9sbGVyIiwiX2xvZGFzaCIsIl9jcnlwdG8iLCJfdHJpZ2dlcnMiLCJfQXV0aCIsIl9Db250cm9sbGVycyIsIl9Db25maWciLCJfbHJ1Q2FjaGUiLCJfVXNlcnNSb3V0ZXIiLCJfRGF0YWJhc2VDb250cm9sbGVyIiwiX3V0aWwiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJQYXJzZUxpdmVRdWVyeVNlcnZlciIsImNvbnN0cnVjdG9yIiwic2VydmVyIiwiY29uZmlnIiwicGFyc2VTZXJ2ZXJDb25maWciLCJjbGllbnRzIiwiTWFwIiwic3Vic2NyaXB0aW9ucyIsImFwcElkIiwiUGFyc2UiLCJhcHBsaWNhdGlvbklkIiwibWFzdGVyS2V5Iiwia2V5UGFpcnMiLCJrZXkiLCJPYmplY3QiLCJrZXlzIiwic2V0IiwibG9nZ2VyIiwidmVyYm9zZSIsImRpc2FibGVTaW5nbGVJbnN0YW5jZSIsInNlcnZlclVSTCIsImluaXRpYWxpemUiLCJqYXZhU2NyaXB0S2V5IiwiY2FjaGVDb250cm9sbGVyIiwiZ2V0Q2FjaGVDb250cm9sbGVyIiwiY2FjaGVUaW1lb3V0IiwiYXV0aENhY2hlIiwiTFJVIiwibWF4IiwidHRsIiwicGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJQYXJzZVdlYlNvY2tldFNlcnZlciIsInBhcnNlV2Vic29ja2V0IiwiX29uQ29ubmVjdCIsInN1YnNjcmliZXIiLCJQYXJzZVB1YlN1YiIsImNyZWF0ZVN1YnNjcmliZXIiLCJjb25uZWN0IiwiaXNPcGVuIiwiUHJvbWlzZSIsInJlc29sdmUiLCJfY3JlYXRlU3Vic2NyaWJlcnMiLCJzaHV0ZG93biIsImFsbCIsInZhbHVlcyIsIm1hcCIsImNsaWVudCIsInBhcnNlV2ViU29ja2V0Iiwid3MiLCJjbG9zZSIsIkFycmF5IiwiZnJvbSIsInVuc3Vic2NyaWJlIiwiZXJyIiwiZXJyb3IiLCJtZXNzYWdlUmVjaWV2ZWQiLCJjaGFubmVsIiwibWVzc2FnZVN0ciIsIm1lc3NhZ2UiLCJKU09OIiwicGFyc2UiLCJfY2xlYXJDYWNoZWRSb2xlcyIsInVzZXJJZCIsIl9pbmZsYXRlUGFyc2VPYmplY3QiLCJfb25BZnRlclNhdmUiLCJfb25BZnRlckRlbGV0ZSIsIm9uIiwiZmllbGQiLCJzdWJzY3JpYmUiLCJjdXJyZW50UGFyc2VPYmplY3QiLCJVc2VyUm91dGVyIiwicmVtb3ZlSGlkZGVuUHJvcGVydGllcyIsImNsYXNzTmFtZSIsInBhcnNlT2JqZWN0IiwiX2ZpbmlzaEZldGNoIiwib3JpZ2luYWxQYXJzZU9iamVjdCIsImRlbGV0ZWRQYXJzZU9iamVjdCIsInRvSlNPTiIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlkIiwic2l6ZSIsImNsYXNzU3Vic2NyaXB0aW9ucyIsImdldCIsImRlYnVnIiwic3Vic2NyaXB0aW9uIiwiaXNTdWJzY3JpcHRpb25NYXRjaGVkIiwiX21hdGNoZXNTdWJzY3JpcHRpb24iLCJjbGllbnRJZCIsInJlcXVlc3RJZHMiLCJfIiwiZW50cmllcyIsImNsaWVudFJlcXVlc3RJZHMiLCJmb3JFYWNoIiwicmVxdWVzdElkIiwibG9jYWxEZWxldGVkUGFyc2VPYmplY3QiLCJzdHJpbmdpZnkiLCJhY2wiLCJnZXRBQ0wiLCJvcCIsIl9nZXRDTFBPcGVyYXRpb24iLCJxdWVyeSIsInJlcyIsIm1hdGNoZXNDTFAiLCJfbWF0Y2hlc0NMUCIsImlzTWF0Y2hlZCIsIl9tYXRjaGVzQUNMIiwiZXZlbnQiLCJzZXNzaW9uVG9rZW4iLCJvYmplY3QiLCJ1c2VNYXN0ZXJLZXkiLCJoYXNNYXN0ZXJLZXkiLCJpbnN0YWxsYXRpb25JZCIsInNlbmRFdmVudCIsInRyaWdnZXIiLCJnZXRUcmlnZ2VyIiwiYXV0aCIsImdldEF1dGhGcm9tQ2xpZW50IiwidXNlciIsImZyb21KU09OIiwicnVuVHJpZ2dlciIsInRvSlNPTndpdGhPYmplY3RzIiwiX2ZpbHRlclNlbnNpdGl2ZURhdGEiLCJwdXNoRGVsZXRlIiwicmVzb2x2ZUVycm9yIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiY29kZSIsImlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkIiwiaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCIsImxvY2FsQ3VycmVudFBhcnNlT2JqZWN0IiwibG9jYWxPcmlnaW5hbFBhcnNlT2JqZWN0Iiwib3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UiLCJvcmlnaW5hbEFDTCIsImN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UiLCJjdXJyZW50QUNMIiwiaXNPcmlnaW5hbE1hdGNoZWQiLCJpc0N1cnJlbnRNYXRjaGVkIiwiaGFzaCIsInR5cGUiLCJ3YXRjaEZpZWxkc0NoYW5nZWQiLCJfY2hlY2tXYXRjaEZpZWxkcyIsImN1cnJlbnRSZWFkYWJsZSIsIm9yaWdpbmFsUmVhZGFibGUiLCJvcmlnaW5hbCIsImZ1bmN0aW9uTmFtZSIsImNoYXJBdCIsInRvVXBwZXJDYXNlIiwic2xpY2UiLCJyZXF1ZXN0IiwidHY0IiwidmFsaWRhdGUiLCJSZXF1ZXN0U2NoZW1hIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZGVsZXRlIiwic3Vic2NyaXB0aW9uSW5mbyIsInN1YnNjcmlwdGlvbkluZm9zIiwiZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uIiwiaGFzU3Vic2NyaWJpbmdDbGllbnQiLCJfdmFsaWRhdGVRdWVyeUNvbnN0cmFpbnRzIiwid2hlcmUiLCJ1bmRlZmluZWQiLCJpc0FycmF5IiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwic3ViUXVlcnkiLCJjb25zdHJhaW50IiwiJHJlZ2V4IiwicmVnZXgiLCJpc1JlZ0V4cExpa2UiLCJzb3VyY2UiLCJmbGFncyIsInBhdHRlcm4iLCIkb3B0aW9ucyIsIlJlZ0V4cCIsIm1hdGNoZXNRdWVyeSIsInN0cnVjdHVyZWRDbG9uZSIsInZhbGlkVG9rZW5zIiwiUXVlcnkiLCJTZXNzaW9uIiwiZXF1YWxUbyIsIlVzZXIiLCJjcmVhdGVXaXRob3V0RGF0YSIsImZpbmQiLCJ0b2tlbiIsImF1dGhQcm9taXNlIiwiYXV0aDEiLCJhdXRoMiIsImdldEF1dGhGb3JTZXNzaW9uVG9rZW4iLCJjbGVhclJvbGVDYWNoZSIsImZyb21DYWNoZSIsInRoZW4iLCJjYXRjaCIsInJlc3VsdCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsImdldFN1YnNjcmlwdGlvbkluZm8iLCJhY2xHcm91cCIsInB1c2giLCJhcHBDb25maWciLCJDb25maWciLCJfcm9sZXNGb3JDTFBPcGVyYXRpb24iLCJTY2hlbWFDb250cm9sbGVyIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwidGVzdFBvaW50ZXJQZXJtaXNzaW9ucyIsIl9sb2FkUm9sZXNGb3JQcm90ZWN0ZWRGaWVsZHMiLCJjbGllbnRBdXRoIiwiZ2V0VXNlclJvbGVzIiwicHJvdGVjdGVkRmllbGRzIiwic29tZSIsInN0YXJ0c1dpdGgiLCJlbmFibGVMaXZlUXVlcnlDbGFzc0xldmVsUGVybWlzc2lvblJvbGVzIiwib3BQZXJtaXNzaW9ucyIsInNjaGVtYSIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImZpbHRlciIsIm9iaiIsImRhdGFiYXNlIiwiZ2V0RGF0YWJhc2VDb250cm9sbGVyIiwiYWRkUHJvdGVjdGVkRmllbGRzIiwiRGF0YWJhc2VDb250cm9sbGVyIiwiZmlsdGVyU2Vuc2l0aXZlRGF0YSIsInByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0IiwibGVuZ3RoIiwib2JqZWN0SWQiLCJfdmVyaWZ5QUNMIiwiaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkIiwiZ2V0UmVhZEFjY2VzcyIsImFjbF9oYXNfcm9sZXMiLCJwZXJtaXNzaW9uc0J5SWQiLCJyb2xlTmFtZXMiLCJyb2xlIiwiZ2V0U2Vzc2lvbkZyb21DbGllbnQiLCJ3YXRjaCIsImlzRGVlcFN0cmljdEVxdWFsIiwiZ2V0UHVibGljUmVhZEFjY2VzcyIsInN1YnNjcmlwdGlvblRva2VuIiwiY2xpZW50U2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlS2V5cyIsIl9oYXNNYXN0ZXJLZXkiLCJyYW5kb21VVUlEIiwicmVxIiwicHVzaENvbm5lY3QiLCJ2YWxpZEtleVBhaXJzIiwicHJvdG90eXBlIiwiaGFzT3duUHJvcGVydHkiLCJjYWxsIiwiaXNWYWxpZCIsInNlY3JldCIsImF1dGhDYWxsZWQiLCJwYXJzZVF1ZXJ5Iiwid2l0aEpTT04iLCJ0b1BvaW50ZXIiLCJtYXN0ZXIiLCJyYyIsInJlcXVlc3RDb21wbGV4aXR5IiwicXVlcnlEZXB0aCIsIm1heERlcHRoIiwiY2hlY2tEZXB0aCIsIm5vZGUiLCJkZXB0aCIsIml0ZW0iLCJpc0xvZ2ljYWwiLCJhbGxvd1JlZ2V4IiwiY2hlY2tSZWdleCIsInNjaGVtYUNvbnRyb2xsZXIiLCJsb2FkU2NoZW1hIiwidXNlclJvbGVzIiwiY2hlY2tXaGVyZSIsIndoZXJlS2V5Iiwicm9vdEZpZWxkIiwic3BsaXQiLCJpbmNsdWRlcyIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJ3YXRjaEZpZWxkIiwicHJldmlvdXNTdWJzY3JpcHRpb25JbmZvIiwicHJldmlvdXNTdWJzY3JpcHRpb24iLCJwcmV2aW91c0NsYXNzU3Vic2NyaXB0aW9ucyIsInN1YnNjcmlwdGlvbkhhc2giLCJxdWVyeUhhc2giLCJTdWJzY3JpcHRpb24iLCJhZGRTdWJzY3JpcHRpb25JbmZvIiwiYWRkQ2xpZW50U3Vic2NyaXB0aW9uIiwicHVzaFN1YnNjcmliZSIsIm5vdGlmeUNsaWVudCIsImRlbGV0ZVN1YnNjcmlwdGlvbkluZm8iLCJwdXNoVW5zdWJzY3JpYmUiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL0xpdmVRdWVyeS9QYXJzZUxpdmVRdWVyeVNlcnZlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHY0IGZyb20gJ3R2NCc7XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBTdWJzY3JpcHRpb24gfSBmcm9tICcuL1N1YnNjcmlwdGlvbic7XG5pbXBvcnQgeyBDbGllbnQgfSBmcm9tICcuL0NsaWVudCc7XG5pbXBvcnQgeyBQYXJzZVdlYlNvY2tldFNlcnZlciB9IGZyb20gJy4vUGFyc2VXZWJTb2NrZXRTZXJ2ZXInO1xuLy8gQHRzLWlnbm9yZVxuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IFJlcXVlc3RTY2hlbWEgZnJvbSAnLi9SZXF1ZXN0U2NoZW1hJztcbmltcG9ydCB7IG1hdGNoZXNRdWVyeSwgcXVlcnlIYXNoIH0gZnJvbSAnLi9RdWVyeVRvb2xzJztcbmltcG9ydCB7IFBhcnNlUHViU3ViIH0gZnJvbSAnLi9QYXJzZVB1YlN1Yic7XG5pbXBvcnQgU2NoZW1hQ29udHJvbGxlciBmcm9tICcuLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7XG4gIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMsXG4gIGdldFRyaWdnZXIsXG4gIHJ1blRyaWdnZXIsXG4gIHJlc29sdmVFcnJvcixcbiAgdG9KU09Od2l0aE9iamVjdHMsXG59IGZyb20gJy4uL3RyaWdnZXJzJztcbmltcG9ydCB7IGdldEF1dGhGb3JTZXNzaW9uVG9rZW4sIEF1dGggfSBmcm9tICcuLi9BdXRoJztcbmltcG9ydCB7IGdldENhY2hlQ29udHJvbGxlciwgZ2V0RGF0YWJhc2VDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IHsgTFJVQ2FjaGUgYXMgTFJVIH0gZnJvbSAnbHJ1LWNhY2hlJztcbmltcG9ydCBVc2VyUm91dGVyIGZyb20gJy4uL1JvdXRlcnMvVXNlcnNSb3V0ZXInO1xuaW1wb3J0IERhdGFiYXNlQ29udHJvbGxlciBmcm9tICcuLi9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgaXNEZWVwU3RyaWN0RXF1YWwgfSBmcm9tICd1dGlsJztcblxuXG5jbGFzcyBQYXJzZUxpdmVRdWVyeVNlcnZlciB7XG4gIHNlcnZlcjogYW55O1xuICBjb25maWc6IGFueTtcbiAgY2xpZW50czogTWFwPHN0cmluZywgYW55PjtcbiAgLy8gY2xhc3NOYW1lIC0+IChxdWVyeUhhc2ggLT4gc3Vic2NyaXB0aW9uKVxuICBzdWJzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBhbnk+O1xuICBwYXJzZVdlYlNvY2tldFNlcnZlcjogYW55O1xuICBrZXlQYWlyczogYW55O1xuICAvLyBUaGUgc3Vic2NyaWJlciB3ZSB1c2UgdG8gZ2V0IG9iamVjdCB1cGRhdGUgZnJvbSBwdWJsaXNoZXJcbiAgc3Vic2NyaWJlcjogYW55O1xuICBhdXRoQ2FjaGU6IGFueTtcbiAgY2FjaGVDb250cm9sbGVyOiBhbnk7XG5cbiAgY29uc3RydWN0b3Ioc2VydmVyOiBhbnksIGNvbmZpZzogYW55ID0ge30sIHBhcnNlU2VydmVyQ29uZmlnOiBhbnkgPSB7fSkge1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuICAgIHRoaXMuY2xpZW50cyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5jb25maWcgPSBjb25maWc7XG5cbiAgICBjb25maWcuYXBwSWQgPSBjb25maWcuYXBwSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgICBjb25maWcubWFzdGVyS2V5ID0gY29uZmlnLm1hc3RlcktleSB8fCBQYXJzZS5tYXN0ZXJLZXk7XG5cbiAgICAvLyBTdG9yZSBrZXlzLCBjb252ZXJ0IG9iaiB0byBtYXBcbiAgICBjb25zdCBrZXlQYWlycyA9IGNvbmZpZy5rZXlQYWlycyB8fCB7fTtcbiAgICB0aGlzLmtleVBhaXJzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGtleVBhaXJzKSkge1xuICAgICAgdGhpcy5rZXlQYWlycy5zZXQoa2V5LCBrZXlQYWlyc1trZXldKTtcbiAgICB9XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ1N1cHBvcnQga2V5IHBhaXJzJywgdGhpcy5rZXlQYWlycyk7XG5cbiAgICAvLyBJbml0aWFsaXplIFBhcnNlXG4gICAgUGFyc2UuT2JqZWN0LmRpc2FibGVTaW5nbGVJbnN0YW5jZSgpO1xuICAgIGNvbnN0IHNlcnZlclVSTCA9IGNvbmZpZy5zZXJ2ZXJVUkwgfHwgUGFyc2Uuc2VydmVyVVJMO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcbiAgICBQYXJzZS5pbml0aWFsaXplKGNvbmZpZy5hcHBJZCwgUGFyc2UuamF2YVNjcmlwdEtleSwgY29uZmlnLm1hc3RlcktleSk7XG5cbiAgICAvLyBUaGUgY2FjaGUgY29udHJvbGxlciBpcyBhIHByb3BlciBjYWNoZSBjb250cm9sbGVyXG4gICAgLy8gd2l0aCBhY2Nlc3MgdG8gVXNlciBhbmQgUm9sZXNcbiAgICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGdldENhY2hlQ29udHJvbGxlcihwYXJzZVNlcnZlckNvbmZpZyk7XG5cbiAgICBjb25maWcuY2FjaGVUaW1lb3V0ID0gY29uZmlnLmNhY2hlVGltZW91dCB8fCA1ICogMTAwMDsgLy8gNXNcblxuICAgIC8vIFRoaXMgYXV0aCBjYWNoZSBzdG9yZXMgdGhlIHByb21pc2VzIGZvciBlYWNoIGF1dGggcmVzb2x1dGlvbi5cbiAgICAvLyBUaGUgbWFpbiBiZW5lZml0IGlzIHRvIGJlIGFibGUgdG8gcmV1c2UgdGhlIHNhbWUgdXNlciAvIHNlc3Npb24gdG9rZW4gcmVzb2x1dGlvbi5cbiAgICB0aGlzLmF1dGhDYWNoZSA9IG5ldyBMUlUoe1xuICAgICAgbWF4OiA1MDAsIC8vIDUwMCBjb25jdXJyZW50XG4gICAgICB0dGw6IGNvbmZpZy5jYWNoZVRpbWVvdXQsXG4gICAgfSk7XG4gICAgLy8gSW5pdGlhbGl6ZSB3ZWJzb2NrZXQgc2VydmVyXG4gICAgdGhpcy5wYXJzZVdlYlNvY2tldFNlcnZlciA9IG5ldyBQYXJzZVdlYlNvY2tldFNlcnZlcihcbiAgICAgIHNlcnZlcixcbiAgICAgIHBhcnNlV2Vic29ja2V0ID0+IHRoaXMuX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldCksXG4gICAgICBjb25maWdcbiAgICApO1xuICAgIHRoaXMuc3Vic2NyaWJlciA9IFBhcnNlUHViU3ViLmNyZWF0ZVN1YnNjcmliZXIoY29uZmlnKTtcbiAgICBpZiAoIXRoaXMuc3Vic2NyaWJlci5jb25uZWN0KSB7XG4gICAgICB0aGlzLmNvbm5lY3QoKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBjb25uZWN0KCkge1xuICAgIGlmICh0aGlzLnN1YnNjcmliZXIuaXNPcGVuKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdGhpcy5zdWJzY3JpYmVyLmNvbm5lY3QgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLnN1YnNjcmliZXIuY29ubmVjdCgpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdWJzY3JpYmVyLmlzT3BlbiA9IHRydWU7XG4gICAgfVxuICAgIHRoaXMuX2NyZWF0ZVN1YnNjcmliZXJzKCk7XG4gIH1cblxuICBhc3luYyBzaHV0ZG93bigpIHtcbiAgICBpZiAodGhpcy5zdWJzY3JpYmVyLmlzT3Blbikge1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAuLi5bLi4udGhpcy5jbGllbnRzLnZhbHVlcygpXS5tYXAoY2xpZW50ID0+IGNsaWVudC5wYXJzZVdlYlNvY2tldC53cy5jbG9zZSgpKSxcbiAgICAgICAgdGhpcy5wYXJzZVdlYlNvY2tldFNlcnZlci5jbG9zZT8uKCksXG4gICAgICAgIC4uLkFycmF5LmZyb20odGhpcy5zdWJzY3JpYmVyLnN1YnNjcmlwdGlvbnM/LmtleXMoKSB8fCBbXSkubWFwKGtleSA9PlxuICAgICAgICAgIHRoaXMuc3Vic2NyaWJlci51bnN1YnNjcmliZShrZXkpXG4gICAgICAgICksXG4gICAgICAgIHRoaXMuc3Vic2NyaWJlci5jbG9zZT8uKCksXG4gICAgICBdKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0aGlzLnN1YnNjcmliZXIuY2xvc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc3Vic2NyaWJlci5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcignUHViU3ViQWRhcHRlciBlcnJvciBvbiBzaHV0ZG93bicsIHsgZXJyb3I6IGVyciB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdWJzY3JpYmVyLmlzT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIF9jcmVhdGVTdWJzY3JpYmVycygpIHtcbiAgICBjb25zdCBtZXNzYWdlUmVjaWV2ZWQgPSAoY2hhbm5lbCwgbWVzc2FnZVN0cikgPT4ge1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ1N1YnNjcmliZSBtZXNzYWdlICVqJywgbWVzc2FnZVN0cik7XG4gICAgICBsZXQgbWVzc2FnZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1lc3NhZ2UgPSBKU09OLnBhcnNlKG1lc3NhZ2VTdHIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSBtZXNzYWdlJywgbWVzc2FnZVN0ciwgZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2NsZWFyQ2FjaGUnKSB7XG4gICAgICAgIHRoaXMuX2NsZWFyQ2FjaGVkUm9sZXMobWVzc2FnZS51c2VySWQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLl9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZSk7XG4gICAgICBpZiAoY2hhbm5lbCA9PT0gUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJTYXZlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlJykge1xuICAgICAgICB0aGlzLl9vbkFmdGVyRGVsZXRlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdHZXQgbWVzc2FnZSAlcyBmcm9tIHVua25vd24gY2hhbm5lbCAlaicsIG1lc3NhZ2UsIGNoYW5uZWwpO1xuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5zdWJzY3JpYmVyLm9uKCdtZXNzYWdlJywgKGNoYW5uZWwsIG1lc3NhZ2VTdHIpID0+IG1lc3NhZ2VSZWNpZXZlZChjaGFubmVsLCBtZXNzYWdlU3RyKSk7XG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBbJ2FmdGVyU2F2ZScsICdhZnRlckRlbGV0ZScsICdjbGVhckNhY2hlJ10pIHtcbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBgJHtQYXJzZS5hcHBsaWNhdGlvbklkfSR7ZmllbGR9YDtcbiAgICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoY2hhbm5lbCwgbWVzc2FnZVN0ciA9PiBtZXNzYWdlUmVjaWV2ZWQoY2hhbm5lbCwgbWVzc2FnZVN0cikpO1xuICAgIH1cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgSlNPTiBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0IEpTT04uXG4gIF9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgLy8gSW5mbGF0ZSBtZXJnZWQgb2JqZWN0XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgVXNlclJvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbGV0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbGV0IHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgIHBhcnNlT2JqZWN0Ll9maW5pc2hGZXRjaChjdXJyZW50UGFyc2VPYmplY3QpO1xuICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgLy8gSW5mbGF0ZSBvcmlnaW5hbCBvYmplY3RcbiAgICBjb25zdCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0O1xuICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBVc2VyUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBjbGFzc05hbWUgPSBvcmlnaW5hbFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICAgIHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKG9yaWdpbmFsUGFyc2VPYmplY3QpO1xuICAgICAgbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBhc3luYyBfb25BZnRlckRlbGV0ZShtZXNzYWdlOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgbGV0IGRlbGV0ZWRQYXJzZU9iamVjdCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LnRvSlNPTigpO1xuICAgIGNvbnN0IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyA9IG1lc3NhZ2UuY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IGRlbGV0ZWRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0NsYXNzTmFtZTogJWogfCBPYmplY3RJZDogJXMnLCBjbGFzc05hbWUsIGRlbGV0ZWRQYXJzZU9iamVjdC5pZCk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAoY29uc3Qgc3Vic2NyaXB0aW9uIG9mIGNsYXNzU3Vic2NyaXB0aW9ucy52YWx1ZXMoKSkge1xuICAgICAgbGV0IGlzU3Vic2NyaXB0aW9uTWF0Y2hlZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlzU3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oZGVsZXRlZFBhcnNlT2JqZWN0LCBzdWJzY3JpcHRpb24pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoYEZhaWxlZCBtYXRjaGluZyBzdWJzY3JpcHRpb24gZm9yIGNsYXNzICR7Y2xhc3NOYW1lfTogJHtlLm1lc3NhZ2V9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKCFpc1N1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKHN1YnNjcmlwdGlvbi5jbGllbnRSZXF1ZXN0SWRzKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmVxdWVzdElkcy5mb3JFYWNoKGFzeW5jIHJlcXVlc3RJZCA9PiB7XG4gICAgICAgICAgLy8gRGVlcC1jbG9uZSBzaGFyZWQgb2JqZWN0IHNvIGVhY2ggY29uY3VycmVudCBjYWxsYmFjayB3b3JrcyBvbiBpdHMgb3duIGNvcHlcbiAgICAgICAgICBsZXQgbG9jYWxEZWxldGVkUGFyc2VPYmplY3QgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGRlbGV0ZWRQYXJzZU9iamVjdCkpO1xuICAgICAgICAgIGNvbnN0IGFjbCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgIC8vIENoZWNrIENMUFxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgbGV0IHJlczogYW55ID0ge307XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXNDTFAgPSBhd2FpdCB0aGlzLl9tYXRjaGVzQ0xQKFxuICAgICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBjbGllbnQsXG4gICAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgICAgb3BcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlc0NMUCA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpc01hdGNoZWQgPSBhd2FpdCB0aGlzLl9tYXRjaGVzQUNMKGFjbCwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgaWYgKCFpc01hdGNoZWQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXMgPSB7XG4gICAgICAgICAgICAgIGV2ZW50OiAnZGVsZXRlJyxcbiAgICAgICAgICAgICAgc2Vzc2lvblRva2VuOiBjbGllbnQuc2Vzc2lvblRva2VuLFxuICAgICAgICAgICAgICBvYmplY3Q6IGxvY2FsRGVsZXRlZFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgICAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGNsaWVudC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgc2VuZEV2ZW50OiB0cnVlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgJ2FmdGVyRXZlbnQnLCBQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgICAgICAgICAgIGlmICh0cmlnZ2VyKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KGNsaWVudCwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgICAgICAgcmVzLnVzZXIgPSBhdXRoLnVzZXI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKHJlcy5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXMub2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcy5vYmplY3QpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IHJ1blRyaWdnZXIodHJpZ2dlciwgYGFmdGVyRXZlbnQuJHtjbGFzc05hbWV9YCwgcmVzLCBhdXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghcmVzLnNlbmRFdmVudCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9iamVjdCAmJiB0eXBlb2YgcmVzLm9iamVjdC50b0pTT04gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgbG9jYWxEZWxldGVkUGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhyZXMub2JqZWN0LCByZXMub2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzLm9iamVjdCA9IGxvY2FsRGVsZXRlZFBhcnNlT2JqZWN0O1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5fZmlsdGVyU2Vuc2l0aXZlRGF0YShcbiAgICAgICAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgICByZXMsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uLnF1ZXJ5XG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY2xpZW50LnB1c2hEZWxldGUocmVxdWVzdElkLCByZXMub2JqZWN0KTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IoY2xpZW50LnBhcnNlV2ViU29ja2V0LCBlcnJvci5jb2RlLCBlcnJvci5tZXNzYWdlLCBmYWxzZSwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGFmdGVyTGl2ZVF1ZXJ5RXZlbnQgb24gY2xhc3MgJHtjbGFzc05hbWV9IGZvciBldmVudCAke3Jlcy5ldmVudH0gd2l0aCBzZXNzaW9uICR7cmVzLnNlc3Npb25Ub2tlbn0gd2l0aDpcXG4gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyIGFmdGVyIGluZmxhdGVkLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgYWZ0ZXIgY2hhbmdlcy5cbiAgLy8gTWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0IGlzIHRoZSBvcmlnaW5hbCBQYXJzZU9iamVjdC5cbiAgYXN5bmMgX29uQWZ0ZXJTYXZlKG1lc3NhZ2U6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxvZ2dlci52ZXJib3NlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJTYXZlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgbGV0IG9yaWdpbmFsUGFyc2VPYmplY3QgPSBudWxsO1xuICAgIGlmIChtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgfVxuICAgIGNvbnN0IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyA9IG1lc3NhZ2UuY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIGxldCBjdXJyZW50UGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBjdXJyZW50UGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDbGFzc05hbWU6ICVzIHwgT2JqZWN0SWQ6ICVzJywgY2xhc3NOYW1lLCBjdXJyZW50UGFyc2VPYmplY3QuaWQpO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudCBudW1iZXIgOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcblxuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAodHlwZW9mIGNsYXNzU3Vic2NyaXB0aW9ucyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZygnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcyAnICsgY2xhc3NOYW1lKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzdWJzY3JpcHRpb24gb2YgY2xhc3NTdWJzY3JpcHRpb25zLnZhbHVlcygpKSB7XG4gICAgICBsZXQgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQ7XG4gICAgICBsZXQgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICAgIHN1YnNjcmlwdGlvblxuICAgICAgICApO1xuICAgICAgICBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgICBjdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgRmFpbGVkIG1hdGNoaW5nIHN1YnNjcmlwdGlvbiBmb3IgY2xhc3MgJHtjbGFzc05hbWV9OiAke2UubWVzc2FnZX1gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKHN1YnNjcmlwdGlvbi5jbGllbnRSZXF1ZXN0SWRzKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmVxdWVzdElkcy5mb3JFYWNoKGFzeW5jIHJlcXVlc3RJZCA9PiB7XG4gICAgICAgICAgLy8gRGVlcC1jbG9uZSBzaGFyZWQgb2JqZWN0cyBzbyBlYWNoIGNvbmN1cnJlbnQgY2FsbGJhY2sgd29ya3Mgb24gaXRzIG93biBjb3B5LlxuICAgICAgICAgIC8vIFdpdGhvdXQgY2xvbmluZywgX2ZpbHRlclNlbnNpdGl2ZURhdGEncyBpbi1wbGFjZSBmaWVsZCBkZWxldGlvbiBhbmQgYWZ0ZXJFdmVudFxuICAgICAgICAgIC8vIHRyaWdnZXIgbW9kaWZpY2F0aW9ucyBjb3JydXB0IHRoZSBzaGFyZWQgc3RhdGUgYWNyb3NzIGNvbmN1cnJlbnQgc3Vic2NyaWJlcnMuXG4gICAgICAgICAgbGV0IGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShjdXJyZW50UGFyc2VPYmplY3QpKTtcbiAgICAgICAgICBsZXQgbG9jYWxPcmlnaW5hbFBhcnNlT2JqZWN0ID0gb3JpZ2luYWxQYXJzZU9iamVjdFxuICAgICAgICAgICAgPyBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG9yaWdpbmFsUGFyc2VPYmplY3QpKVxuICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgIC8vIFNldCBvcmlnbmFsIFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCkge1xuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0w7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgIG9yaWdpbmFsQUNMID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSB0aGlzLl9tYXRjaGVzQUNMKG9yaWdpbmFsQUNMLCBjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFNldCBjdXJyZW50IFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZTtcbiAgICAgICAgICBsZXQgcmVzOiBhbnkgPSB7fTtcbiAgICAgICAgICBpZiAoIWlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50QUNMID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QuZ2V0QUNMKCk7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChjdXJyZW50QUNMLCBjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBvcCA9IHRoaXMuX2dldENMUE9wZXJhdGlvbihzdWJzY3JpcHRpb24ucXVlcnkpO1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlc0NMUCA9IGF3YWl0IHRoaXMuX21hdGNoZXNDTFAoXG4gICAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgICAgbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgICBvcFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzQ0xQID09PSBmYWxzZSkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBbaXNPcmlnaW5hbE1hdGNoZWQsIGlzQ3VycmVudE1hdGNoZWRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICAgICAgICAgICdPcmlnaW5hbCAlaiB8IEN1cnJlbnQgJWogfCBNYXRjaDogJXMsICVzLCAlcywgJXMgfCBRdWVyeTogJXMnLFxuICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCxcbiAgICAgICAgICAgICAgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCxcbiAgICAgICAgICAgICAgaXNPcmlnaW5hbE1hdGNoZWQsXG4gICAgICAgICAgICAgIGlzQ3VycmVudE1hdGNoZWQsXG4gICAgICAgICAgICAgIHN1YnNjcmlwdGlvbi5oYXNoXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgIGxldCB0eXBlO1xuICAgICAgICAgICAgaWYgKGlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgdHlwZSA9ICd1cGRhdGUnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpc09yaWdpbmFsTWF0Y2hlZCAmJiAhaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICB0eXBlID0gJ2xlYXZlJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgaWYgKGxvY2FsT3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSAnZW50ZXInO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSAnY3JlYXRlJztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB3YXRjaEZpZWxkc0NoYW5nZWQgPSB0aGlzLl9jaGVja1dhdGNoRmllbGRzKGNsaWVudCwgcmVxdWVzdElkLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIGlmICghd2F0Y2hGaWVsZHNDaGFuZ2VkICYmICh0eXBlID09PSAndXBkYXRlJyB8fCB0eXBlID09PSAnY3JlYXRlJykpIHtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQSBgbGVhdmVgIG9yIGBlbnRlcmAgdHJhbnNpdGlvbiBjYW4gYmUgY2F1c2VkIGVpdGhlciBieSB0aGUgb2JqZWN0J3NcbiAgICAgICAgICAgIC8vIHF1ZXJ5IG1hdGNoIGNoYW5naW5nICh0aGUgc3Vic2NyaWJlciBrZWVwcyByZWFkIGFjY2Vzcykgb3IgYnkgdGhlXG4gICAgICAgICAgICAvLyBzdWJzY3JpYmVyJ3MgQUNMIHJlYWQgYWNjZXNzIGJlaW5nIHJldm9rZWQgb3IgZ3JhbnRlZCBpbiB0aGUgc2FtZSBzYXZlLlxuICAgICAgICAgICAgLy8gSW4gdGhlIGFjY2Vzcy1jaGFuZ2UgY2FzZSB0aGUgc3Vic2NyaWJlciBpcyBub3QgYXV0aG9yaXplZCB0byByZWFkIHRoZVxuICAgICAgICAgICAgLy8gb2JqZWN0IHN0YXRlIHRoYXQgdHJpZ2dlcmVkIHRoZSB0cmFuc2l0aW9uLCBzbyB0aGF0IHN0YXRlIG11c3Qgbm90IGJlXG4gICAgICAgICAgICAvLyBzZW50IG92ZXIgdGhlIGNoYW5uZWwuIChDTFAgcmVhZCBkZW5pYWwgaXMgaGFuZGxlZCBlYXJsaWVyIGJ5XG4gICAgICAgICAgICAvLyBgX21hdGNoZXNDTFBgLCB3aGljaCBza2lwcyB0aGUgZXZlbnQgZW50aXJlbHkuKVxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdsZWF2ZScpIHtcbiAgICAgICAgICAgICAgLy8gVGhlIHBvc3QtdXBkYXRlIG9iamVjdCBpcyByZWFkYWJsZSBvbiBhIHF1ZXJ5LW1pc21hdGNoIGxlYXZlIGJ1dCBub3RcbiAgICAgICAgICAgICAgLy8gb24gYW4gQUNMLWxvc3MgbGVhdmUuIE9ubHkgc2VuZCB0aGUgcG9zdC11cGRhdGUgYm9keSB3aGVuIHRoZVxuICAgICAgICAgICAgICAvLyBzdWJzY3JpYmVyIGNhbiBzdGlsbCByZWFkIHRoZSBjdXJyZW50IG9iamVjdDsgb3RoZXJ3aXNlIGZhbGwgYmFjayB0b1xuICAgICAgICAgICAgICAvLyB0aGUgbGFzdCBhdXRob3JpemVkIChvcmlnaW5hbCkgc3RhdGUsIHdoaWNoIHN0aWxsIGNhcnJpZXMgdGhlIG9iamVjdElkLlxuICAgICAgICAgICAgICBjb25zdCBjdXJyZW50UmVhZGFibGUgPSBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxuICAgICAgICAgICAgICAgIDogYXdhaXQgdGhpcy5fbWF0Y2hlc0FDTChtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC5nZXRBQ0woKSwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgICBpZiAoIWN1cnJlbnRSZWFkYWJsZSkge1xuICAgICAgICAgICAgICAgIGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZW50ZXInKSB7XG4gICAgICAgICAgICAgIC8vIFRoZSBwcmUtdXBkYXRlIG9iamVjdCB3YXMgcmVhZGFibGUgb24gYSBxdWVyeS1tYXRjaC1nYWluIGVudGVyIGJ1dCBub3RcbiAgICAgICAgICAgICAgLy8gb24gYW4gQUNMLWdyYW50IGVudGVyLiBPbmx5IHNlbmQgdGhlIHByZS11cGRhdGUgYm9keSBhcyBgb3JpZ2luYWxgXG4gICAgICAgICAgICAgIC8vIHdoZW4gdGhlIHN1YnNjcmliZXIgY291bGQgcmVhZCB0aGUgb3JpZ2luYWwgb2JqZWN0LlxuICAgICAgICAgICAgICBjb25zdCBvcmlnaW5hbFJlYWRhYmxlID0gaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWRcbiAgICAgICAgICAgICAgICA/IGZhbHNlXG4gICAgICAgICAgICAgICAgOiBhd2FpdCB0aGlzLl9tYXRjaGVzQUNMKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKSwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgICBpZiAoIW9yaWdpbmFsUmVhZGFibGUpIHtcbiAgICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXMgPSB7XG4gICAgICAgICAgICAgIGV2ZW50OiB0eXBlLFxuICAgICAgICAgICAgICBzZXNzaW9uVG9rZW46IGNsaWVudC5zZXNzaW9uVG9rZW4sXG4gICAgICAgICAgICAgIG9iamVjdDogbG9jYWxDdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIG9yaWdpbmFsOiBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgICAgICAgdXNlTWFzdGVyS2V5OiBjbGllbnQuaGFzTWFzdGVyS2V5LFxuICAgICAgICAgICAgICBpbnN0YWxsYXRpb25JZDogY2xpZW50Lmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgICBzZW5kRXZlbnQ6IHRydWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCAnYWZ0ZXJFdmVudCcsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICAgICAgICAgICAgaWYgKHRyaWdnZXIpIHtcbiAgICAgICAgICAgICAgaWYgKHJlcy5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXMub2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcy5vYmplY3QpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChyZXMub3JpZ2luYWwpIHtcbiAgICAgICAgICAgICAgICByZXMub3JpZ2luYWwgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04ocmVzLm9yaWdpbmFsKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgdGhpcy5nZXRBdXRoRnJvbUNsaWVudChjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICAgIGlmIChhdXRoICYmIGF1dGgudXNlcikge1xuICAgICAgICAgICAgICAgIHJlcy51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IHJ1blRyaWdnZXIodHJpZ2dlciwgYGFmdGVyRXZlbnQuJHtjbGFzc05hbWV9YCwgcmVzLCBhdXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghcmVzLnNlbmRFdmVudCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9iamVjdCAmJiB0eXBlb2YgcmVzLm9iamVjdC50b0pTT04gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgbG9jYWxDdXJyZW50UGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhyZXMub2JqZWN0LCByZXMub2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlcy5vcmlnaW5hbCAmJiB0eXBlb2YgcmVzLm9yaWdpbmFsLnRvSlNPTiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhcbiAgICAgICAgICAgICAgICByZXMub3JpZ2luYWwsXG4gICAgICAgICAgICAgICAgcmVzLm9yaWdpbmFsLmNsYXNzTmFtZSB8fCBjbGFzc05hbWVcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlcy5vYmplY3QgPSBsb2NhbEN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICAgICAgICAgIHJlcy5vcmlnaW5hbCA9IGxvY2FsT3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgICAgcmVzLFxuICAgICAgICAgICAgICBjbGllbnQsXG4gICAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgIHN1YnNjcmlwdGlvbi5xdWVyeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGNvbnN0IGZ1bmN0aW9uTmFtZSA9ICdwdXNoJyArIHJlcy5ldmVudC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHJlcy5ldmVudC5zbGljZSgxKTtcbiAgICAgICAgICAgIGlmIChjbGllbnRbZnVuY3Rpb25OYW1lXSkge1xuICAgICAgICAgICAgICBjbGllbnRbZnVuY3Rpb25OYW1lXShyZXF1ZXN0SWQsIHJlcy5vYmplY3QsIHJlcy5vcmlnaW5hbCA/PyBudWxsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IoY2xpZW50LnBhcnNlV2ViU29ja2V0LCBlcnJvci5jb2RlLCBlcnJvci5tZXNzYWdlLCBmYWxzZSwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGFmdGVyTGl2ZVF1ZXJ5RXZlbnQgb24gY2xhc3MgJHtjbGFzc05hbWV9IGZvciBldmVudCAke3Jlcy5ldmVudH0gd2l0aCBzZXNzaW9uICR7cmVzLnNlc3Npb25Ub2tlbn0gd2l0aDpcXG4gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIF9vbkNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSk6IHZvaWQge1xuICAgIHBhcnNlV2Vic29ja2V0Lm9uKCdtZXNzYWdlJywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAodHlwZW9mIHJlcXVlc3QgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVxdWVzdCA9IEpTT04ucGFyc2UocmVxdWVzdCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSByZXF1ZXN0JywgcmVxdWVzdCwgZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBsb2dnZXIudmVyYm9zZSgnUmVxdWVzdDogJWonLCByZXF1ZXN0KTtcblxuICAgICAgLy8gQ2hlY2sgd2hldGhlciB0aGlzIHJlcXVlc3QgaXMgYSB2YWxpZCByZXF1ZXN0LCByZXR1cm4gZXJyb3IgZGlyZWN0bHkgaWYgbm90XG4gICAgICBpZiAoXG4gICAgICAgICF0djQudmFsaWRhdGUocmVxdWVzdCwgUmVxdWVzdFNjaGVtYVsnZ2VuZXJhbCddKSB8fFxuICAgICAgICAhdHY0LnZhbGlkYXRlKHJlcXVlc3QsIFJlcXVlc3RTY2hlbWFbcmVxdWVzdC5vcF0pXG4gICAgICApIHtcbiAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMSwgdHY0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0Nvbm5lY3QgbWVzc2FnZSBlcnJvciAlcycsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2ggKHJlcXVlc3Qub3ApIHtcbiAgICAgICAgY2FzZSAnY29ubmVjdCc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlQ29ubmVjdChwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3N1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICd1bnN1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDMsICdHZXQgdW5rbm93biBvcGVyYXRpb24nKTtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0dldCB1bmtub3duIG9wZXJhdGlvbicsIHJlcXVlc3Qub3ApO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcGFyc2VXZWJzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCAoKSA9PiB7XG4gICAgICBsb2dnZXIuaW5mbyhgQ2xpZW50IGRpc2Nvbm5lY3Q6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgICBjb25zdCBjbGllbnRJZCA9IHBhcnNlV2Vic29ja2V0LmNsaWVudElkO1xuICAgICAgaWYgKCF0aGlzLmNsaWVudHMuaGFzKGNsaWVudElkKSkge1xuICAgICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3RfZXJyb3InLFxuICAgICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgICAgIGVycm9yOiBgVW5hYmxlIHRvIGZpbmQgY2xpZW50ICR7Y2xpZW50SWR9YCxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgQ2FuIG5vdCBmaW5kIGNsaWVudCAke2NsaWVudElkfSBvbiBkaXNjb25uZWN0YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRGVsZXRlIGNsaWVudFxuICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICB0aGlzLmNsaWVudHMuZGVsZXRlKGNsaWVudElkKTtcblxuICAgICAgLy8gRGVsZXRlIGNsaWVudCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgIGZvciAoY29uc3QgW3JlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mb10gb2YgXy5lbnRyaWVzKGNsaWVudC5zdWJzY3JpcHRpb25JbmZvcykpIHtcbiAgICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgICAgIHN1YnNjcmlwdGlvbi5kZWxldGVDbGllbnRTdWJzY3JpcHRpb24oY2xpZW50SWQsIHJlcXVlc3RJZCk7XG5cbiAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xpZW50IHdoaWNoIGlzIHN1YnNjcmliaW5nIHRoaXMgc3Vic2NyaXB0aW9uLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoc3Vic2NyaXB0aW9uLmNsYXNzTmFtZSk7XG4gICAgICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMpIHtcbiAgICAgICAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnRzICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgc3Vic2NyaXB0aW9ucyAlZCcsIHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplKTtcbiAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3QnLFxuICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGNsaWVudC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgc2Vzc2lvblRva2VuOiBjbGllbnQuc2Vzc2lvblRva2VuLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnd3NfY29ubmVjdCcsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuICB9XG5cbiAgX3ZhbGlkYXRlUXVlcnlDb25zdHJhaW50cyh3aGVyZTogYW55KTogdm9pZCB7XG4gICAgaWYgKHR5cGVvZiB3aGVyZSAhPT0gJ29iamVjdCcgfHwgd2hlcmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBvcCBvZiBbJyRvcicsICckYW5kJywgJyRub3InXSkge1xuICAgICAgaWYgKHdoZXJlW29wXSAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIGAke29wfSBtdXN0IGJlIGFuIGFycmF5YCk7XG4gICAgICB9XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh3aGVyZVtvcF0pKSB7XG4gICAgICAgIHdoZXJlW29wXS5mb3JFYWNoKChzdWJRdWVyeTogYW55KSA9PiB7XG4gICAgICAgICAgdGhpcy5fdmFsaWRhdGVRdWVyeUNvbnN0cmFpbnRzKHN1YlF1ZXJ5KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHdoZXJlKSkge1xuICAgICAgY29uc3QgY29uc3RyYWludCA9IHdoZXJlW2tleV07XG4gICAgICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgPT09ICdvYmplY3QnICYmIGNvbnN0cmFpbnQgIT09IG51bGwpIHtcbiAgICAgICAgaWYgKGNvbnN0cmFpbnQuJHJlZ2V4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCByZWdleCA9IGNvbnN0cmFpbnQuJHJlZ2V4O1xuICAgICAgICAgIGNvbnN0IGlzUmVnRXhwTGlrZSA9XG4gICAgICAgICAgICByZWdleCAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgdHlwZW9mIHJlZ2V4ID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgdHlwZW9mIHJlZ2V4LnNvdXJjZSA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICAgIHR5cGVvZiByZWdleC5mbGFncyA9PT0gJ3N0cmluZyc7XG4gICAgICAgICAgaWYgKHR5cGVvZiByZWdleCAhPT0gJ3N0cmluZycgJiYgIWlzUmVnRXhwTGlrZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICAnSW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb246ICRyZWdleCBtdXN0IGJlIGEgc3RyaW5nIG9yIFJlZ0V4cCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHBhdHRlcm4gPSBpc1JlZ0V4cExpa2UgPyByZWdleC5zb3VyY2UgOiByZWdleDtcbiAgICAgICAgICBjb25zdCBmbGFncyA9IGlzUmVnRXhwTGlrZSA/IHJlZ2V4LmZsYWdzIDogY29uc3RyYWludC4kb3B0aW9ucyB8fCAnJztcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbmV3IFJlZ0V4cChwYXR0ZXJuLCBmbGFncyk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICBgSW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb246ICR7ZS5tZXNzYWdlfWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgX21hdGNoZXNTdWJzY3JpcHRpb24ocGFyc2VPYmplY3Q6IGFueSwgc3Vic2NyaXB0aW9uOiBhbnkpOiBib29sZWFuIHtcbiAgICAvLyBPYmplY3QgaXMgdW5kZWZpbmVkIG9yIG51bGwsIG5vdCBtYXRjaFxuICAgIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIG1hdGNoZXNRdWVyeShzdHJ1Y3R1cmVkQ2xvbmUocGFyc2VPYmplY3QpLCBzdWJzY3JpcHRpb24ucXVlcnkpO1xuICB9XG5cbiAgYXN5bmMgX2NsZWFyQ2FjaGVkUm9sZXModXNlcklkOiBzdHJpbmcpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsaWRUb2tlbnMgPSBhd2FpdCBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuU2Vzc2lvbilcbiAgICAgICAgLmVxdWFsVG8oJ3VzZXInLCBQYXJzZS5Vc2VyLmNyZWF0ZVdpdGhvdXREYXRhKHVzZXJJZCkpXG4gICAgICAgIC5maW5kKHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pO1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIHZhbGlkVG9rZW5zLm1hcChhc3luYyB0b2tlbiA9PiB7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvblRva2VuID0gdG9rZW4uZ2V0KCdzZXNzaW9uVG9rZW4nKTtcbiAgICAgICAgICBjb25zdCBhdXRoUHJvbWlzZSA9IHRoaXMuYXV0aENhY2hlLmdldChzZXNzaW9uVG9rZW4pO1xuICAgICAgICAgIGlmICghYXV0aFByb21pc2UpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgW2F1dGgxLCBhdXRoMl0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgICBhdXRoUHJvbWlzZSxcbiAgICAgICAgICAgIGdldEF1dGhGb3JTZXNzaW9uVG9rZW4oeyBjYWNoZUNvbnRyb2xsZXI6IHRoaXMuY2FjaGVDb250cm9sbGVyLCBzZXNzaW9uVG9rZW4gfSksXG4gICAgICAgICAgXSk7XG4gICAgICAgICAgYXV0aDEuYXV0aD8uY2xlYXJSb2xlQ2FjaGUoc2Vzc2lvblRva2VuKTtcbiAgICAgICAgICBhdXRoMi5hdXRoPy5jbGVhclJvbGVDYWNoZShzZXNzaW9uVG9rZW4pO1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLmRlbGV0ZShzZXNzaW9uVG9rZW4pO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIudmVyYm9zZShgQ291bGQgbm90IGNsZWFyIHJvbGUgY2FjaGUuICR7ZX1gKTtcbiAgICB9XG4gIH1cblxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuKHNlc3Npb25Ub2tlbj86IHN0cmluZyk6IFByb21pc2U8eyBhdXRoPzogQXV0aCwgdXNlcklkPzogc3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gICAgfVxuICAgIGNvbnN0IGZyb21DYWNoZSA9IHRoaXMuYXV0aENhY2hlLmdldChzZXNzaW9uVG9rZW4pO1xuICAgIGlmIChmcm9tQ2FjaGUpIHtcbiAgICAgIHJldHVybiBmcm9tQ2FjaGU7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhQcm9taXNlID0gZ2V0QXV0aEZvclNlc3Npb25Ub2tlbih7XG4gICAgICBjYWNoZUNvbnRyb2xsZXI6IHRoaXMuY2FjaGVDb250cm9sbGVyLFxuICAgICAgc2Vzc2lvblRva2VuOiBzZXNzaW9uVG9rZW4sXG4gICAgfSlcbiAgICAgIC50aGVuKGF1dGggPT4ge1xuICAgICAgICByZXR1cm4geyBhdXRoLCB1c2VySWQ6IGF1dGggJiYgYXV0aC51c2VyICYmIGF1dGgudXNlci5pZCB9O1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFRoZXJlIHdhcyBhbiBlcnJvciB3aXRoIHRoZSBzZXNzaW9uIHRva2VuXG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0ge307XG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4pIHtcbiAgICAgICAgICByZXN1bHQuZXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICB0aGlzLmF1dGhDYWNoZS5zZXQoc2Vzc2lvblRva2VuLCBQcm9taXNlLnJlc29sdmUocmVzdWx0KSwge1xuICAgICAgICAgICAgdHRsOiB0aGlzLmNvbmZpZy5jYWNoZVRpbWVvdXQsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5hdXRoQ2FjaGUuZGVsZXRlKHNlc3Npb25Ub2tlbik7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgIH0pO1xuICAgIHRoaXMuYXV0aENhY2hlLnNldChzZXNzaW9uVG9rZW4sIGF1dGhQcm9taXNlKTtcbiAgICByZXR1cm4gYXV0aFByb21pc2U7XG4gIH1cblxuICBhc3luYyBfbWF0Y2hlc0NMUChcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM/OiBhbnksXG4gICAgb2JqZWN0PzogYW55LFxuICAgIGNsaWVudD86IGFueSxcbiAgICByZXF1ZXN0SWQ/OiBudW1iZXIsXG4gICAgb3A/OiBzdHJpbmdcbiAgKTogUHJvbWlzZTxhbnk+IHtcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBjb25zdCBhY2xHcm91cCA9IFsnKiddO1xuICAgIGxldCB1c2VySWQ7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgLy8gRmFsbCBiYWNrIHRvIHRoZSBjb25uZWN0LWZyYW1lIHRva2VuLCB0aGUgc2FtZSB3YXkgYF9tYXRjaGVzQUNMYCxcbiAgICAgIC8vIGBnZXRBdXRoRnJvbUNsaWVudGAgYW5kIGBfZmlsdGVyU2Vuc2l0aXZlRGF0YWAgYWxyZWFkeSBkby4gVGhlIHN1YnNjcmliZVxuICAgICAgLy8gZnJhbWUncyBzZXNzaW9uIHRva2VuIGlzIG9wdGlvbmFsLCBzbyByZXNvbHZpbmcgb25seSBpdCB3b3VsZCBldmFsdWF0ZSB0aGVcbiAgICAgIC8vIENMUCBhZ2FpbnN0IGFuIGFub255bW91cyBpZGVudGl0eSB3aGlsZSB0aGUgQUNMIGNoZWNrIGF1dGhvcml6ZWQgdGhlIHJlYWRcbiAgICAgIC8vIGFnYWluc3QgdGhlIGNvbm5lY3RlZCB1c2VyLlxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKFxuICAgICAgICBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbiB8fCBjbGllbnQuc2Vzc2lvblRva2VuXG4gICAgICApO1xuICAgICAgdXNlcklkID0gcmVzdWx0LnVzZXJJZDtcbiAgICAgIGlmICh1c2VySWQpIHtcbiAgICAgICAgYWNsR3JvdXAucHVzaCh1c2VySWQpO1xuICAgICAgICAvLyBSZWFkIHBlciBjYWxsIHJhdGhlciB0aGFuIGNhY2hpbmcgb24gdGhlIGluc3RhbmNlOiB0aGUgd2hvbGUgYXBwIGNvbmZpZ1xuICAgICAgICAvLyBjYW4gYmUgcmVwbGFjZWQgYXQgcnVudGltZSB0aHJvdWdoIHRoZSBgUGFyc2UuU2VydmVyYCBzZXR0ZXIuXG4gICAgICAgIGNvbnN0IGFwcENvbmZpZyA9IENvbmZpZy5nZXQodGhpcy5jb25maWcuYXBwSWQpO1xuICAgICAgICBhY2xHcm91cC5wdXNoKFxuICAgICAgICAgIC4uLihhd2FpdCB0aGlzLl9yb2xlc0ZvckNMUE9wZXJhdGlvbihcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIHJlc3VsdC5hdXRoLFxuICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICBhcHBDb25maWdcbiAgICAgICAgICApKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgIG9iamVjdC5jbGFzc05hbWUsXG4gICAgICBhY2xHcm91cCxcbiAgICAgIG9wXG4gICAgKTtcbiAgICAvLyBFbmZvcmNlIHBvaW50ZXIgcGVybWlzc2lvbnMgdGhhdCB2YWxpZGF0ZVBlcm1pc3Npb24gZGVmZXJzLlxuICAgIC8vIFJldHVybnMgZmFsc2UgdG8gc2lsZW50bHkgc2tpcCB0aGUgZXZlbnQgKGxpa2UgQUNMKSwgcmF0aGVyIHRoYW5cbiAgICAvLyB0aHJvd2luZyB3aGljaCB3b3VsZCBwdXNoIGVycm9ycyB0byB0aGUgY2xpZW50IGFuZCBsb2cgbm9pc2UuXG4gICAgaWYgKFxuICAgICAgIWNsaWVudC5oYXNNYXN0ZXJLZXkgJiZcbiAgICAgICFTY2hlbWFDb250cm9sbGVyLnRlc3RQb2ludGVyUGVybWlzc2lvbnMoY2xhc3NMZXZlbFBlcm1pc3Npb25zLCBhY2xHcm91cCwgb3AsIHVzZXJJZCwgZmllbGQgPT5cbiAgICAgICAgdHlwZW9mIG9iamVjdC5nZXQgPT09ICdmdW5jdGlvbicgPyBvYmplY3QuZ2V0KGZpZWxkKSA6IG9iamVjdFtmaWVsZF1cbiAgICAgIClcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvLyBgYWRkUHJvdGVjdGVkRmllbGRzYCByZWFkcyByb2xlLXNjb3BlZCBgcHJvdGVjdGVkRmllbGRzYCBncm91cHMgZnJvbVxuICAvLyBgQXV0aC51c2VyUm9sZXNgLCB3aGljaCBzdGF5cyBlbXB0eSB1bmxlc3MgdGhlIHJvbGVzIGFyZSBleHBsaWNpdGx5IGxvYWRlZC5cbiAgLy8gV2l0aG91dCB0aGlzLCBldmVyeSBgcm9sZTpgIGdyb3VwIGlzIHNpbGVudGx5IHNraXBwZWQgYW5kIExpdmVRdWVyeSB3b3VsZFxuICAvLyBkaXNjbG9zZSBmaWVsZHMgdGhhdCB0aGUgUkVTVCBwYXRoIHN0cmlwcyBmb3IgdGhlIHNhbWUgY2FsbGVyLiBUaGUgcm9sZXMgYXJlXG4gIC8vIG9ubHkgZmV0Y2hlZCB3aGVuIHRoZSBjbGFzcyBhY3R1YWxseSBkZWNsYXJlcyBhIGByb2xlOmAgZ3JvdXAsIHNvIGNsYXNzZXNcbiAgLy8gd2l0aG91dCBvbmUga2VlcCBzdWJzY3JpYmluZyBhbmQgcmVjZWl2aW5nIGV2ZW50cyB3aXRob3V0IGEgcm9sZSBsb29rdXAuXG4gIGFzeW5jIF9sb2FkUm9sZXNGb3JQcm90ZWN0ZWRGaWVsZHMoY2xhc3NMZXZlbFBlcm1pc3Npb25zPzogYW55LCBjbGllbnRBdXRoPzogYW55KSB7XG4gICAgaWYgKHR5cGVvZiBjbGllbnRBdXRoPy5nZXRVc2VyUm9sZXMgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcHJvdGVjdGVkRmllbGRzID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zPy5wcm90ZWN0ZWRGaWVsZHM7XG4gICAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMgfHwgQXJyYXkuaXNBcnJheShwcm90ZWN0ZWRGaWVsZHMpKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghT2JqZWN0LmtleXMocHJvdGVjdGVkRmllbGRzKS5zb21lKGtleSA9PiBrZXkuc3RhcnRzV2l0aCgncm9sZTonKSkpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgY2xpZW50QXV0aC5nZXRVc2VyUm9sZXMoKTtcbiAgfVxuXG4gIC8vIGBTY2hlbWFDb250cm9sbGVyLnRlc3RQZXJtaXNzaW9uc2AgbWF0Y2hlcyBDTFAgZW50cmllcyBhZ2FpbnN0IHRoZSBjYWxsZXInc1xuICAvLyBBQ0wgZ3JvdXAsIHNvIGEgYHJvbGU6YCBncmFudCBvbmx5IGFwcGxpZXMgd2hlbiB0aGUgY2FsbGVyJ3Mgcm9sZXMgYXJlIGluIHRoYXRcbiAgLy8gZ3JvdXAuIFRoZSBSRVNUIHBhdGggYnVpbGRzIHRoZSBzYW1lIGdyb3VwIGluIGBSZXN0UXVlcnkuZ2V0VXNlckFuZFJvbGVBQ0xgO1xuICAvLyB3aXRob3V0IHRoaXMgTGl2ZVF1ZXJ5IGRlbmllcyBgZmluZGAvYGdldGAgdG8gbGVnaXRpbWF0ZSByb2xlIG1lbWJlcnMgdGhhdCB0aGVcbiAgLy8gZXF1aXZhbGVudCBSRVNUIHF1ZXJ5IHNlcnZlcy5cbiAgLy9cbiAgLy8gSG9ub3VyaW5nIHRoZSBncmFudCB3aWRlbnMgd2hhdCBMaXZlUXVlcnkgZGVsaXZlcnMsIHNvIGl0IGlzIG9wdC1pbiB1bnRpbCB0aGVcbiAgLy8gbmV4dCBtYWpvciB2aWEgYGVuYWJsZUxpdmVRdWVyeUNsYXNzTGV2ZWxQZXJtaXNzaW9uUm9sZXNgIChzZWUgREVQUFMyNSkuIFRoZVxuICAvLyBvcHRpb24gbGl2ZXMgb24gYFBhcnNlU2VydmVyT3B0aW9uc2AsIHdoaWNoIGlzIE5PVCB3aGF0IGB0aGlzLmNvbmZpZ2AgaG9sZHMgLS1cbiAgLy8gdGhhdCBpcyBgbGl2ZVF1ZXJ5U2VydmVyT3B0aW9uc2AgLS0gc28gaXQgaGFzIHRvIGJlIHJlYWQgdGhyb3VnaCBgQ29uZmlnLmdldGAuXG4gIC8vIFRoZSBvcHRpb25hbCBjaGFpbmluZyBpcyByZXF1aXJlZDogYENvbmZpZy5nZXRgIHJldHVybnMgYHVuZGVmaW5lZGAgZm9yIGFcbiAgLy8gc3RhbmRhbG9uZSBMaXZlUXVlcnkgc2VydmVyLCB3aG9zZSBgQXBwQ2FjaGVgIGlzIGVtcHR5LlxuICAvL1xuICAvLyBUaGUgcm9sZXMgYXJlIG9ubHkgcmVzb2x2ZWQgd2hlbiB0aGUgb3BlcmF0aW9uJ3MgQ0xQIGFjdHVhbGx5IGRlY2xhcmVzIGFcbiAgLy8gYHJvbGU6YCBlbnRyeSwgc28gY2xhc3NlcyB0aGF0IGdyYW50IGJ5IGAqYCBvciBieSB1c2VyIGlkIGtlZXAgbWF0Y2hpbmcgZXZlbnRzXG4gIC8vIHdpdGhvdXQgYSByb2xlIGxvb2t1cC5cbiAgYXN5bmMgX3JvbGVzRm9yQ0xQT3BlcmF0aW9uKFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucz86IGFueSxcbiAgICBjbGllbnRBdXRoPzogYW55LFxuICAgIG9wPzogc3RyaW5nLFxuICAgIGFwcENvbmZpZz86IGFueVxuICApOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgaWYgKCFhcHBDb25maWc/LmVuYWJsZUxpdmVRdWVyeUNsYXNzTGV2ZWxQZXJtaXNzaW9uUm9sZXMpIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBjbGllbnRBdXRoPy5nZXRVc2VyUm9sZXMgIT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3Qgb3BQZXJtaXNzaW9ucyA9IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucz8uW29wXTtcbiAgICBpZiAoIW9wUGVybWlzc2lvbnMgfHwgdHlwZW9mIG9wUGVybWlzc2lvbnMgIT09ICdvYmplY3QnKSB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGlmICghT2JqZWN0LmtleXMob3BQZXJtaXNzaW9ucykuc29tZShrZXkgPT4ga2V5LnN0YXJ0c1dpdGgoJ3JvbGU6JykpKSB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBjbGllbnRBdXRoLmdldFVzZXJSb2xlcygpO1xuICB9XG5cbiAgYXN5bmMgX2ZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zPzogYW55LFxuICAgIHJlcz86IGFueSxcbiAgICBjbGllbnQ/OiBhbnksXG4gICAgcmVxdWVzdElkPzogbnVtYmVyLFxuICAgIG9wPzogc3RyaW5nLFxuICAgIHF1ZXJ5PzogYW55XG4gICkge1xuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGNvbnN0IGFjbEdyb3VwID0gWycqJ107XG4gICAgbGV0IGNsaWVudEF1dGg7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgLy8gRmFsbCBiYWNrIHRvIHRoZSBjb25uZWN0LWZyYW1lIHRva2VuLCB0aGUgc2FtZSB3YXkgYF9tYXRjaGVzQUNMYCBhbmRcbiAgICAgIC8vIGBnZXRBdXRoRnJvbUNsaWVudGAgYWxyZWFkeSBkby4gVGhlIHN1YnNjcmliZSBmcmFtZSdzIHNlc3Npb24gdG9rZW4gaXNcbiAgICAgIC8vIG9wdGlvbmFsLCBzbyByZXNvbHZpbmcgb25seSBpdCB3b3VsZCByZWRhY3QgYWdhaW5zdCBhbiBhbm9ueW1vdXMgaWRlbnRpdHlcbiAgICAgIC8vIHdoaWxlIHRoZSBBQ0wgY2hlY2sgYXV0aG9yaXplZCB0aGUgcmVhZCBhZ2FpbnN0IHRoZSBjb25uZWN0ZWQgdXNlci4gVGhhdFxuICAgICAgLy8gbWlzbWF0Y2ggc2tpcHMgZXZlcnkgaWRlbnRpdHktZGVyaXZlZCBgcHJvdGVjdGVkRmllbGRzYCBncm91cFxuICAgICAgLy8gKGByb2xlOmAsIGBhdXRoZW50aWNhdGVkYCBhbmQgYDxvYmplY3RJZD5gKS5cbiAgICAgIGNvbnN0IHsgdXNlcklkLCBhdXRoIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oXG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuIHx8IGNsaWVudC5zZXNzaW9uVG9rZW5cbiAgICAgICk7XG4gICAgICBpZiAodXNlcklkKSB7XG4gICAgICAgIGFjbEdyb3VwLnB1c2godXNlcklkKTtcbiAgICAgIH1cbiAgICAgIGNsaWVudEF1dGggPSBhdXRoO1xuICAgIH1cbiAgICBpZiAoIWNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgIGF3YWl0IHRoaXMuX2xvYWRSb2xlc0ZvclByb3RlY3RlZEZpZWxkcyhjbGFzc0xldmVsUGVybWlzc2lvbnMsIGNsaWVudEF1dGgpO1xuICAgIH1cbiAgICAvLyBgRGF0YWJhc2VDb250cm9sbGVyLmZpbHRlclNlbnNpdGl2ZURhdGFgIHJlYWRzIHRoZSBjbGFzcyBwZXJtaXNzaW9ucyB0aHJvdWdoXG4gICAgLy8gYHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKWAgYW5kIGZhbGxzIGJhY2sgdG8gYHt9YCB3aGVuIHRoZVxuICAgIC8vIGFyZ3VtZW50IGRvZXMgbm90IGV4cG9zZSB0aGF0IG1ldGhvZC4gVGhlIExpdmVRdWVyeSBzZXJ2ZXIgb25seSBldmVyIGhvbGRzXG4gICAgLy8gdGhlIHNlcmlhbGl6ZWQgQ0xQIGZyb20gdGhlIHB1Ymxpc2hlZCBtZXNzYWdlIGFuZCBoYXMgbm8gYFNjaGVtYUNvbnRyb2xsZXJgXG4gICAgLy8gZm9yIHRoZSBjbGFzcywgc28gcGFzc2luZyB0aGUgcmF3IENMUCBzaWxlbnRseSBza2lwcGVkIHRoZSBlbnRpcmVcbiAgICAvLyBgdXNlckZpZWxkOmAgYmxvY2s6IHRob3NlIGdyb3VwcyBpbnRlcnNlY3QgYWdhaW5zdCB0aGUgb3RoZXIgZ3JvdXBzLCBzb1xuICAgIC8vIHNraXBwaW5nIHRoZW0gbGVmdCBmaWVsZHMgcHJvdGVjdGVkIHRoYXQgdGhlIFJFU1QgcGF0aCByZXR1cm5zLiBXcmFwIHRoZSBDTFBcbiAgICAvLyBzbyB0aGUgaGVscGVyIGNhbiByZWFjaCBpdC4gKGBhZGRQcm90ZWN0ZWRGaWVsZHNgIGFib3ZlIG5lZWRzIG5vIHdyYXBwZXIgLS1cbiAgICAvLyBpdCBhbHJlYWR5IGZhbGxzIGJhY2sgdG8gdHJlYXRpbmcgaXRzIGFyZ3VtZW50IGFzIHRoZSBwZXJtaXNzaW9ucyBvYmplY3QuKVxuICAgIGNvbnN0IHNjaGVtYSA9IHsgZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zOiAoKSA9PiBjbGFzc0xldmVsUGVybWlzc2lvbnMgfTtcbiAgICAvLyBQYXJzZSBTZXJ2ZXIgb3B0aW9ucywgbm90IExpdmVRdWVyeSBvcHRpb25zXG4gICAgY29uc3QgYXBwQ29uZmlnID0gY2xpZW50Lmhhc01hc3RlcktleSA/IHVuZGVmaW5lZCA6IENvbmZpZy5nZXQodGhpcy5jb25maWcuYXBwSWQpO1xuICAgIGNvbnN0IGZpbHRlciA9IG9iaiA9PiB7XG4gICAgICBpZiAoIW9iaikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBsZXQgcHJvdGVjdGVkRmllbGRzID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zPy5wcm90ZWN0ZWRGaWVsZHMgfHwgW107XG4gICAgICBpZiAoY2xpZW50Lmhhc01hc3RlcktleSkge1xuICAgICAgICBwcm90ZWN0ZWRGaWVsZHMgPSBbXTtcbiAgICAgIH0gZWxzZSBpZiAoIUFycmF5LmlzQXJyYXkocHJvdGVjdGVkRmllbGRzKSkge1xuICAgICAgICAvLyBTdGFuZGFsb25lIHNlcnZlciBoYXMgbm8gYXBwIGNvbmZpZ1xuICAgICAgICBjb25zdCBkYXRhYmFzZSA9IGFwcENvbmZpZz8uZGF0YWJhc2UgfHwgZ2V0RGF0YWJhc2VDb250cm9sbGVyKHRoaXMuY29uZmlnKTtcbiAgICAgICAgcHJvdGVjdGVkRmllbGRzID0gZGF0YWJhc2UuYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICByZXMub2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICBjbGllbnRBdXRoXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gRGF0YWJhc2VDb250cm9sbGVyLmZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgIGNsaWVudC5oYXNNYXN0ZXJLZXksXG4gICAgICAgIGZhbHNlLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgY2xpZW50QXV0aCxcbiAgICAgICAgb3AsXG4gICAgICAgIHNjaGVtYSxcbiAgICAgICAgcmVzLm9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIHByb3RlY3RlZEZpZWxkcyxcbiAgICAgICAgb2JqLFxuICAgICAgICBhcHBDb25maWc/LnByb3RlY3RlZEZpZWxkc093bmVyRXhlbXB0XG4gICAgICApO1xuICAgIH07XG4gICAgcmVzLm9iamVjdCA9IGZpbHRlcihyZXMub2JqZWN0KTtcbiAgICByZXMub3JpZ2luYWwgPSBmaWx0ZXIocmVzLm9yaWdpbmFsKTtcbiAgfVxuXG4gIF9nZXRDTFBPcGVyYXRpb24ocXVlcnk6IGFueSkge1xuICAgIHJldHVybiB0eXBlb2YgcXVlcnkgPT09ICdvYmplY3QnICYmXG4gICAgICBPYmplY3Qua2V5cyhxdWVyeSkubGVuZ3RoID09IDEgJiZcbiAgICAgIHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZydcbiAgICAgID8gJ2dldCdcbiAgICAgIDogJ2ZpbmQnO1xuICB9XG5cbiAgYXN5bmMgX3ZlcmlmeUFDTChhY2w6IGFueSwgdG9rZW46IHN0cmluZykge1xuICAgIGlmICghdG9rZW4pIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGF1dGgsIHVzZXJJZCB9ID0gYXdhaXQgdGhpcy5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKHRva2VuKTtcblxuICAgIC8vIEdldHRpbmcgdGhlIHNlc3Npb24gdG9rZW4gZmFpbGVkXG4gICAgLy8gVGhpcyBtZWFucyB0aGF0IG5vIGFkZGl0aW9uYWwgYXV0aCBpcyBhdmFpbGFibGVcbiAgICAvLyBBdCB0aGlzIHBvaW50LCBqdXN0IGJhaWwgb3V0IGFzIG5vIGFkZGl0aW9uYWwgdmlzaWJpbGl0eSBjYW4gYmUgaW5mZXJyZWQuXG4gICAgaWYgKCFhdXRoIHx8ICF1c2VySWQpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkID0gYWNsLmdldFJlYWRBY2Nlc3ModXNlcklkKTtcbiAgICBpZiAoaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiB0aGUgdXNlciBoYXMgYW55IHJvbGVzIHRoYXQgbWF0Y2ggdGhlIEFDTFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBSZXNvbHZlIGZhbHNlIHJpZ2h0IGF3YXkgaWYgdGhlIGFjbCBkb2Vzbid0IGhhdmUgYW55IHJvbGVzXG4gICAgICAgIGNvbnN0IGFjbF9oYXNfcm9sZXMgPSBPYmplY3Qua2V5cyhhY2wucGVybWlzc2lvbnNCeUlkKS5zb21lKGtleSA9PiBrZXkuc3RhcnRzV2l0aCgncm9sZTonKSk7XG4gICAgICAgIGlmICghYWNsX2hhc19yb2xlcykge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb2xlTmFtZXMgPSBhd2FpdCBhdXRoLmdldFVzZXJSb2xlcygpO1xuICAgICAgICAvLyBGaW5hbGx5LCBzZWUgaWYgYW55IG9mIHRoZSB1c2VyJ3Mgcm9sZXMgYWxsb3cgdGhlbSByZWFkIGFjY2Vzc1xuICAgICAgICBmb3IgKGNvbnN0IHJvbGUgb2Ygcm9sZU5hbWVzKSB7XG4gICAgICAgICAgLy8gV2UgdXNlIGdldFJlYWRBY2Nlc3MgYXMgYHJvbGVgIGlzIGluIHRoZSBmb3JtIGByb2xlOnJvbGVOYW1lYFxuICAgICAgICAgIGlmIChhY2wuZ2V0UmVhZEFjY2Vzcyhyb2xlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKCkgPT4ge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGdldEF1dGhGcm9tQ2xpZW50KGNsaWVudDogYW55LCByZXF1ZXN0SWQ6IG51bWJlciwgc2Vzc2lvblRva2VuPzogc3RyaW5nKSB7XG4gICAgY29uc3QgZ2V0U2Vzc2lvbkZyb21DbGllbnQgPSAoKSA9PiB7XG4gICAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgICAgcmV0dXJuIGNsaWVudC5zZXNzaW9uVG9rZW47XG4gICAgICB9XG4gICAgICByZXR1cm4gc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4gfHwgY2xpZW50LnNlc3Npb25Ub2tlbjtcbiAgICB9O1xuICAgIGlmICghc2Vzc2lvblRva2VuKSB7XG4gICAgICBzZXNzaW9uVG9rZW4gPSBnZXRTZXNzaW9uRnJvbUNsaWVudCgpO1xuICAgIH1cbiAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB7IGF1dGggfSA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZvclNlc3Npb25Ub2tlbihzZXNzaW9uVG9rZW4pO1xuICAgIHJldHVybiBhdXRoO1xuICB9XG5cbiAgX2NoZWNrV2F0Y2hGaWVsZHMoY2xpZW50OiBhbnksIHJlcXVlc3RJZDogYW55LCBtZXNzYWdlOiBhbnkpIHtcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBjb25zdCB3YXRjaCA9IHN1YnNjcmlwdGlvbkluZm8/LndhdGNoO1xuICAgIGlmICghd2F0Y2gpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBjb25zdCBvYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICBjb25zdCBvcmlnaW5hbCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgICByZXR1cm4gd2F0Y2guc29tZShmaWVsZCA9PiAhaXNEZWVwU3RyaWN0RXF1YWwob2JqZWN0LmdldChmaWVsZCksIG9yaWdpbmFsPy5nZXQoZmllbGQpKSk7XG4gIH1cblxuICBhc3luYyBfbWF0Y2hlc0FDTChhY2w6IGFueSwgY2xpZW50OiBhbnksIHJlcXVlc3RJZDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgLy8gUmV0dXJuIHRydWUgZGlyZWN0bHkgaWYgQUNMIGlzbid0IHByZXNlbnQsIEFDTCBpcyBwdWJsaWMgcmVhZCwgb3IgY2xpZW50IGhhcyBtYXN0ZXIga2V5XG4gICAgaWYgKCFhY2wgfHwgYWNsLmdldFB1YmxpY1JlYWRBY2Nlc3MoKSB8fCBjbGllbnQuaGFzTWFzdGVyS2V5KSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQ2hlY2sgc3Vic2NyaXB0aW9uIHNlc3Npb25Ub2tlbiBtYXRjaGVzIEFDTCBmaXJzdFxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJzY3JpcHRpb25Ub2tlbiA9IHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuO1xuICAgIGNvbnN0IGNsaWVudFNlc3Npb25Ub2tlbiA9IGNsaWVudC5zZXNzaW9uVG9rZW47XG5cbiAgICBpZiAoYXdhaXQgdGhpcy5fdmVyaWZ5QUNMKGFjbCwgc3Vic2NyaXB0aW9uVG9rZW4pKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAoYXdhaXQgdGhpcy5fdmVyaWZ5QUNMKGFjbCwgY2xpZW50U2Vzc2lvblRva2VuKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgYXN5bmMgX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICBpZiAoIXRoaXMuX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0LCB0aGlzLmtleVBhaXJzKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgNCwgJ0tleSBpbiByZXF1ZXN0IGlzIG5vdCB2YWxpZCcpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdLZXkgaW4gcmVxdWVzdCBpcyBub3QgdmFsaWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgaGFzTWFzdGVyS2V5ID0gdGhpcy5faGFzTWFzdGVyS2V5KHJlcXVlc3QsIHRoaXMua2V5UGFpcnMpO1xuICAgIGNvbnN0IGNsaWVudElkID0gcmFuZG9tVVVJRCgpO1xuICAgIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoXG4gICAgICBjbGllbnRJZCxcbiAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgaGFzTWFzdGVyS2V5LFxuICAgICAgcmVxdWVzdC5zZXNzaW9uVG9rZW4sXG4gICAgICByZXF1ZXN0Lmluc3RhbGxhdGlvbklkXG4gICAgKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVxID0ge1xuICAgICAgICBjbGllbnQsXG4gICAgICAgIGV2ZW50OiAnY29ubmVjdCcsXG4gICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgc2Vzc2lvblRva2VuOiByZXF1ZXN0LnNlc3Npb25Ub2tlbixcbiAgICAgICAgdXNlTWFzdGVyS2V5OiBjbGllbnQuaGFzTWFzdGVyS2V5LFxuICAgICAgICBpbnN0YWxsYXRpb25JZDogcmVxdWVzdC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgdXNlcjogdW5kZWZpbmVkLFxuICAgICAgfTtcbiAgICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKCdAQ29ubmVjdCcsICdiZWZvcmVDb25uZWN0JywgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gICAgICBpZiAodHJpZ2dlcikge1xuICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgdGhpcy5nZXRBdXRoRnJvbUNsaWVudChjbGllbnQsIHJlcXVlc3QucmVxdWVzdElkLCByZXEuc2Vzc2lvblRva2VuKTtcbiAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgcmVxLnVzZXIgPSBhdXRoLnVzZXI7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgcnVuVHJpZ2dlcih0cmlnZ2VyLCBgYmVmb3JlQ29ubmVjdC5AQ29ubmVjdGAsIHJlcSwgYXV0aCk7XG4gICAgICB9XG4gICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCA9IGNsaWVudElkO1xuICAgICAgdGhpcy5jbGllbnRzLnNldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgY2xpZW50KTtcbiAgICAgIGxvZ2dlci5pbmZvKGBDcmVhdGUgbmV3IGNsaWVudDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH1gKTtcbiAgICAgIGNsaWVudC5wdXNoQ29ubmVjdCgpO1xuICAgICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyhyZXEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVycm9yID0gcmVzb2x2ZUVycm9yKGUpO1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgZXJyb3IuY29kZSwgZXJyb3IubWVzc2FnZSwgZmFsc2UpO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICBgRmFpbGVkIHJ1bm5pbmcgYmVmb3JlQ29ubmVjdCBmb3Igc2Vzc2lvbiAke3JlcXVlc3Quc2Vzc2lvblRva2VufSB3aXRoOlxcbiBFcnJvcjogYCArXG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZXJyb3IpXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIF9oYXNNYXN0ZXJLZXkocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZiAoIXZhbGlkS2V5UGFpcnMgfHwgdmFsaWRLZXlQYWlycy5zaXplID09IDAgfHwgIXZhbGlkS2V5UGFpcnMuaGFzKCdtYXN0ZXJLZXknKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBpZiAoIXJlcXVlc3QgfHwgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChyZXF1ZXN0LCAnbWFzdGVyS2V5JykpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIHJlcXVlc3QubWFzdGVyS2V5ID09PSB2YWxpZEtleVBhaXJzLmdldCgnbWFzdGVyS2V5Jyk7XG4gIH1cblxuICBfdmFsaWRhdGVLZXlzKHJlcXVlc3Q6IGFueSwgdmFsaWRLZXlQYWlyczogYW55KTogYm9vbGVhbiB7XG4gICAgaWYgKCF2YWxpZEtleVBhaXJzIHx8IHZhbGlkS2V5UGFpcnMuc2l6ZSA9PSAwKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgbGV0IGlzVmFsaWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHNlY3JldF0gb2YgdmFsaWRLZXlQYWlycykge1xuICAgICAgaWYgKCFyZXF1ZXN0W2tleV0gfHwgcmVxdWVzdFtrZXldICE9PSBzZWNyZXQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpc1ZhbGlkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gaXNWYWxpZDtcbiAgfVxuXG4gIGFzeW5jIF9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogUHJvbWlzZTxhbnk+IHtcbiAgICAvLyBJZiB3ZSBjYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIHJldHVybiBlcnJvciB0byBjbGllbnRcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwYXJzZVdlYnNvY2tldCwgJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSBzdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgc3Vic2NyaWJpbmcnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcmVxdWVzdC5xdWVyeS5jbGFzc05hbWU7XG4gICAgbGV0IGF1dGhDYWxsZWQgPSBmYWxzZTtcbiAgICBsZXQgY2xpZW50QXV0aDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCAnYmVmb3JlU3Vic2NyaWJlJywgUGFyc2UuYXBwbGljYXRpb25JZCk7XG4gICAgICBpZiAodHJpZ2dlcikge1xuICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgdGhpcy5nZXRBdXRoRnJvbUNsaWVudChjbGllbnQsIHJlcXVlc3QucmVxdWVzdElkLCByZXF1ZXN0LnNlc3Npb25Ub2tlbik7XG4gICAgICAgIGF1dGhDYWxsZWQgPSB0cnVlO1xuICAgICAgICBjbGllbnRBdXRoID0gYXV0aDtcbiAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgcmVxdWVzdC51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICAgICAgICBwYXJzZVF1ZXJ5LndpdGhKU09OKHJlcXVlc3QucXVlcnkpO1xuICAgICAgICByZXF1ZXN0LnF1ZXJ5ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgYXdhaXQgcnVuVHJpZ2dlcih0cmlnZ2VyLCBgYmVmb3JlU3Vic2NyaWJlLiR7Y2xhc3NOYW1lfWAsIHJlcXVlc3QsIGF1dGgpO1xuXG4gICAgICAgIGNvbnN0IHF1ZXJ5ID0gcmVxdWVzdC5xdWVyeS50b0pTT04oKTtcbiAgICAgICAgcmVxdWVzdC5xdWVyeSA9IHF1ZXJ5O1xuICAgICAgfVxuXG4gICAgICBpZiAoY2xhc3NOYW1lID09PSAnX1Nlc3Npb24nKSB7XG4gICAgICAgIGlmICghYXV0aENhbGxlZCkge1xuICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWQsXG4gICAgICAgICAgICByZXF1ZXN0LnNlc3Npb25Ub2tlblxuICAgICAgICAgICk7XG4gICAgICAgICAgY2xpZW50QXV0aCA9IGF1dGg7XG4gICAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgICByZXF1ZXN0LnVzZXIgPSBhdXRoLnVzZXI7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0LnVzZXIpIHtcbiAgICAgICAgICByZXF1ZXN0LnF1ZXJ5LndoZXJlLnVzZXIgPSByZXF1ZXN0LnVzZXIudG9Qb2ludGVyKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoIXJlcXVlc3QubWFzdGVyKSB7XG4gICAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgICAgICAgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsXG4gICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgIHJlcXVlc3QucmVxdWVzdElkXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIFZhbGlkYXRlIHF1ZXJ5IGNvbmRpdGlvbiBkZXB0aFxuICAgICAgY29uc3QgYXBwQ29uZmlnID0gQ29uZmlnLmdldCh0aGlzLmNvbmZpZy5hcHBJZCk7XG4gICAgICBpZiAoIWNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgICAgY29uc3QgcmMgPSBhcHBDb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gICAgICAgIGlmIChyYyAmJiByYy5xdWVyeURlcHRoICE9PSAtMSkge1xuICAgICAgICAgIGNvbnN0IG1heERlcHRoID0gcmMucXVlcnlEZXB0aDtcbiAgICAgICAgICBjb25zdCBjaGVja0RlcHRoID0gKG5vZGU6IGFueSwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgICAgICAgICAgaWYgKGRlcHRoID4gbWF4RGVwdGgpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICAgICAgYFF1ZXJ5IGNvbmRpdGlvbiBuZXN0aW5nIGRlcHRoIGV4Y2VlZHMgbWF4aW11bSBhbGxvd2VkIGRlcHRoIG9mICR7bWF4RGVwdGh9YFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgdHlwZW9mIG5vZGUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KG5vZGUpKSB7XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBub2RlKSB7XG4gICAgICAgICAgICAgICAgY2hlY2tEZXB0aChpdGVtLCBkZXB0aCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gRGVzY2VuZCBpbnRvIGV2ZXJ5IHZhbHVlIHNvIHRoYXQgbG9naWNhbCBvcGVyYXRvcnMgKCRvci8kYW5kLyRub3IpXG4gICAgICAgICAgICAvLyBuZXN0ZWQgdW5kZXIgZmllbGQtbGV2ZWwgb3BlcmF0b3JzIChlLmcuICRlbGVtTWF0Y2gsICRub3QpIG9yIHBsYWluXG4gICAgICAgICAgICAvLyBmaWVsZCBuYW1lcyBhcmUgc3RpbGwgY291bnRlZC4gT25seSBsb2dpY2FsIG9wZXJhdG9ycyBpbmNyZWFzZSB0aGVcbiAgICAgICAgICAgIC8vIGRlcHRoLCB3aGljaCBwcmVzZXJ2ZXMgdGhlIGRvY3VtZW50ZWQgbWVhbmluZyBvZiBgcXVlcnlEZXB0aGAuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgICAgICAgICAgICBjb25zdCBpc0xvZ2ljYWwgPSBrZXkgPT09ICckb3InIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRub3InO1xuICAgICAgICAgICAgICBpZiAoaXNMb2dpY2FsICYmICFBcnJheS5pc0FycmF5KG5vZGVba2V5XSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYCR7a2V5fSBtdXN0IGJlIGFuIGFycmF5YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgY2hlY2tEZXB0aChub2RlW2tleV0sIGlzTG9naWNhbCA/IGRlcHRoICsgMSA6IGRlcHRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9O1xuICAgICAgICAgIGNoZWNrRGVwdGgocmVxdWVzdC5xdWVyeS53aGVyZSwgMCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgYWxsb3dSZWdleFxuICAgICAgaWYgKCFjbGllbnQuaGFzTWFzdGVyS2V5KSB7XG4gICAgICAgIGNvbnN0IHJjID0gYXBwQ29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICAgICAgICBpZiAocmMgJiYgcmMuYWxsb3dSZWdleCA9PT0gZmFsc2UpIHtcbiAgICAgICAgICBjb25zdCBjaGVja1JlZ2V4ID0gKHdoZXJlOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygd2hlcmUgIT09ICdvYmplY3QnIHx8IHdoZXJlID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHdoZXJlKSkge1xuICAgICAgICAgICAgICBjb25zdCBjb25zdHJhaW50ID0gd2hlcmVba2V5XTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zdHJhaW50ID09PSAnb2JqZWN0JyAmJiBjb25zdHJhaW50ICE9PSBudWxsICYmIGNvbnN0cmFpbnQuJHJlZ2V4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRyZWdleCBvcGVyYXRvciBpcyBub3QgYWxsb3dlZCcpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmb3IgKGNvbnN0IG9wIG9mIFsnJG9yJywgJyRhbmQnLCAnJG5vciddKSB7XG4gICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHN1YlF1ZXJ5IG9mIHdoZXJlW29wXSkge1xuICAgICAgICAgICAgICAgICAgY2hlY2tSZWdleChzdWJRdWVyeSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjaGVja1JlZ2V4KHJlcXVlc3QucXVlcnkud2hlcmUpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIENMUCBmb3Igc3Vic2NyaWJlIG9wZXJhdGlvblxuICAgICAgY29uc3Qgc2NoZW1hQ29udHJvbGxlciA9IGF3YWl0IGFwcENvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKCk7XG4gICAgICBjb25zdCBjbGFzc0xldmVsUGVybWlzc2lvbnMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpO1xuICAgICAgY29uc3Qgb3AgPSB0aGlzLl9nZXRDTFBPcGVyYXRpb24ocmVxdWVzdC5xdWVyeSk7XG4gICAgICBjb25zdCBhY2xHcm91cCA9IFsnKiddO1xuICAgICAgaWYgKCFhdXRoQ2FsbGVkKSB7XG4gICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KFxuICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZCxcbiAgICAgICAgICByZXF1ZXN0LnNlc3Npb25Ub2tlblxuICAgICAgICApO1xuICAgICAgICBhdXRoQ2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgY2xpZW50QXV0aCA9IGF1dGg7XG4gICAgICAgIGlmIChhdXRoICYmIGF1dGgudXNlcikge1xuICAgICAgICAgIHJlcXVlc3QudXNlciA9IGF1dGgudXNlcjtcbiAgICAgICAgICBhY2xHcm91cC5wdXNoKGF1dGgudXNlci5pZCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAocmVxdWVzdC51c2VyKSB7XG4gICAgICAgIGFjbEdyb3VwLnB1c2gocmVxdWVzdC51c2VyLmlkKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnVzZXIpIHtcbiAgICAgICAgYWNsR3JvdXAucHVzaChcbiAgICAgICAgICAuLi4oYXdhaXQgdGhpcy5fcm9sZXNGb3JDTFBPcGVyYXRpb24oXG4gICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICBjbGllbnRBdXRoLFxuICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICBhcHBDb25maWdcbiAgICAgICAgICApKVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgYXdhaXQgU2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oXG4gICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgb3BcbiAgICAgICk7XG5cbiAgICAgIC8vIENoZWNrIHByb3RlY3RlZCBmaWVsZHMgaW4gV0hFUkUgY2xhdXNlIGFuZCBXQVRDSCBwYXJhbWV0ZXJcbiAgICAgIGlmICghY2xpZW50Lmhhc01hc3RlcktleSkge1xuICAgICAgICBhd2FpdCB0aGlzLl9sb2FkUm9sZXNGb3JQcm90ZWN0ZWRGaWVsZHMoY2xhc3NMZXZlbFBlcm1pc3Npb25zLCBjbGllbnRBdXRoKTtcbiAgICAgICAgLy8gYGNsaWVudEF1dGhgIGlzIHVuZGVmaW5lZCBvbmx5IHdoZW4gbm8gc2Vzc2lvbiB0b2tlbiB3YXMgc3VwcGxpZWQgb25cbiAgICAgICAgLy8gZWl0aGVyIGZyYW1lLCBpbiB3aGljaCBjYXNlIGEgYGJlZm9yZVN1YnNjcmliZWAgdHJpZ2dlciBpcyB0aGUgb25seSB3YXlcbiAgICAgICAgLy8gYHJlcXVlc3QudXNlcmAgY2FuIGJlIHNldC4gVGhlcmUgaXMgbm8gc2Vzc2lvbiB0byByZXNvbHZlIHJvbGVzIGZyb20gZm9yXG4gICAgICAgIC8vIHN1Y2ggYSB0cmlnZ2VyLWFzc2lnbmVkIHVzZXIsIHNvIGByb2xlOmAgZ3JvdXBzIGNhbm5vdCBiZSBhcHBsaWVkIHRvIGl0LlxuICAgICAgICBjb25zdCBhdXRoID0gcmVxdWVzdC51c2VyID8gY2xpZW50QXV0aCB8fCB7IHVzZXI6IHJlcXVlc3QudXNlciwgdXNlclJvbGVzOiBbXSB9IDoge307XG4gICAgICAgIGNvbnN0IHByb3RlY3RlZEZpZWxkcyA9XG4gICAgICAgICAgYXBwQ29uZmlnLmRhdGFiYXNlLmFkZFByb3RlY3RlZEZpZWxkcyhcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIHJlcXVlc3QucXVlcnkud2hlcmUsXG4gICAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICAgIGF1dGhcbiAgICAgICAgICApIHx8IFtdO1xuICAgICAgICBpZiAocHJvdGVjdGVkRmllbGRzLmxlbmd0aCA+IDAgJiYgcmVxdWVzdC5xdWVyeS53aGVyZSkge1xuICAgICAgICAgIGNvbnN0IGNoZWNrV2hlcmUgPSAod2hlcmU6IGFueSkgPT4ge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB3aGVyZSAhPT0gJ29iamVjdCcgfHwgd2hlcmUgPT09IG51bGwpIHtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm9yIChjb25zdCB3aGVyZUtleSBvZiBPYmplY3Qua2V5cyh3aGVyZSkpIHtcbiAgICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkID0gd2hlcmVLZXkuc3BsaXQoJy4nKVswXTtcbiAgICAgICAgICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyh3aGVyZUtleSkgfHwgcHJvdGVjdGVkRmllbGRzLmluY2x1ZGVzKHJvb3RGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgICAgICAgJ1Blcm1pc3Npb24gZGVuaWVkJ1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3Qgb3Agb2YgWyckb3InLCAnJGFuZCcsICckbm9yJ10pIHtcbiAgICAgICAgICAgICAgaWYgKHdoZXJlW29wXSAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYCR7b3B9IG11c3QgYmUgYW4gYXJyYXlgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh3aGVyZVtvcF0pKSB7XG4gICAgICAgICAgICAgICAgd2hlcmVbb3BdLmZvckVhY2goKHN1YlF1ZXJ5OiBhbnkpID0+IGNoZWNrV2hlcmUoc3ViUXVlcnkpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH07XG4gICAgICAgICAgY2hlY2tXaGVyZShyZXF1ZXN0LnF1ZXJ5LndoZXJlKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAocHJvdGVjdGVkRmllbGRzLmxlbmd0aCA+IDAgJiYgQXJyYXkuaXNBcnJheShyZXF1ZXN0LnF1ZXJ5LndhdGNoKSkge1xuICAgICAgICAgIGZvciAoY29uc3Qgd2F0Y2hGaWVsZCBvZiByZXF1ZXN0LnF1ZXJ5LndhdGNoKSB7XG4gICAgICAgICAgICBjb25zdCByb290RmllbGQgPSB3YXRjaEZpZWxkLnNwbGl0KCcuJylbMF07XG4gICAgICAgICAgICBpZiAocHJvdGVjdGVkRmllbGRzLmluY2x1ZGVzKHdhdGNoRmllbGQpIHx8IHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhyb290RmllbGQpKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLFxuICAgICAgICAgICAgICAgICdQZXJtaXNzaW9uIGRlbmllZCdcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgcmVnZXggcGF0dGVybnMgaW4gdGhlIHN1YnNjcmlwdGlvbiBxdWVyeVxuICAgICAgdGhpcy5fdmFsaWRhdGVRdWVyeUNvbnN0cmFpbnRzKHJlcXVlc3QucXVlcnkud2hlcmUpO1xuXG4gICAgICAvLyBJZiB0aGlzIGNsaWVudCBhbHJlYWR5IGhhcyBhIHN1YnNjcmlwdGlvbiByZWdpc3RlcmVkIHVuZGVyIHRoaXNcbiAgICAgIC8vIHJlcXVlc3RJZCwgcmVwbGFjZSBpdCBieSB0ZWFyaW5nIGRvd24gdGhlIHByZXZpb3VzIHN1YnNjcmlwdGlvbiBiZWZvcmVcbiAgICAgIC8vIGNyZWF0aW5nIHRoZSBuZXcgb25lLiBUaGUgY2xpZW50LXNpZGUgbWV0YWRhdGEgbWFwIGlzIGtleWVkIG9ubHkgYnlcbiAgICAgIC8vIHJlcXVlc3RJZCwgc28gYSBkdXBsaWNhdGUgYHN1YnNjcmliZWAgZnJhbWUgd291bGQgb3RoZXJ3aXNlIG92ZXJ3cml0ZSBpdFxuICAgICAgLy8gd2hpbGUgdGhlIHByZXZpb3VzIFN1YnNjcmlwdGlvbiBzdGF5cyBpbiB0aGUgc2VydmVyLXdpZGUgbWFwLCBsZWFraW5nIGl0XG4gICAgICAvLyBmb3IgdGhlIGxpZmV0aW1lIG9mIHRoZSBwcm9jZXNzIChkaXNjb25uZWN0IGNsZWFudXAgb25seSB3YWxrcyB0aGVcbiAgICAgIC8vIHN1cnZpdmluZyBjbGllbnQgbWV0YWRhdGEgYW5kIG5ldmVyIHJlYWNoZXMgdGhlIG9ycGhhbmVkIHN1YnNjcmlwdGlvbikuXG4gICAgICBjb25zdCBwcmV2aW91c1N1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0LnJlcXVlc3RJZCk7XG4gICAgICBpZiAocHJldmlvdXNTdWJzY3JpcHRpb25JbmZvKSB7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzU3Vic2NyaXB0aW9uID0gcHJldmlvdXNTdWJzY3JpcHRpb25JbmZvLnN1YnNjcmlwdGlvbjtcbiAgICAgICAgcHJldmlvdXNTdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCByZXF1ZXN0LnJlcXVlc3RJZCk7XG4gICAgICAgIGNvbnN0IHByZXZpb3VzQ2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChwcmV2aW91c1N1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICBpZiAocHJldmlvdXNDbGFzc1N1YnNjcmlwdGlvbnMpIHtcbiAgICAgICAgICBpZiAoIXByZXZpb3VzU3Vic2NyaXB0aW9uLmhhc1N1YnNjcmliaW5nQ2xpZW50KCkpIHtcbiAgICAgICAgICAgIHByZXZpb3VzQ2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShwcmV2aW91c1N1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHByZXZpb3VzQ2xhc3NTdWJzY3JpcHRpb25zLnNpemUgPT09IDApIHtcbiAgICAgICAgICAgIHRoaXMuc3Vic2NyaXB0aW9ucy5kZWxldGUocHJldmlvdXNTdWJzY3JpcHRpb24uY2xhc3NOYW1lKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gR2V0IHN1YnNjcmlwdGlvbiBmcm9tIHN1YnNjcmlwdGlvbnMsIGNyZWF0ZSBvbmUgaWYgbmVjZXNzYXJ5XG4gICAgICBjb25zdCBzdWJzY3JpcHRpb25IYXNoID0gcXVlcnlIYXNoKHJlcXVlc3QucXVlcnkpO1xuICAgICAgLy8gQWRkIGNsYXNzTmFtZSB0byBzdWJzY3JpcHRpb25zIGlmIG5lY2Vzc2FyeVxuXG4gICAgICBpZiAoIXRoaXMuc3Vic2NyaXB0aW9ucy5oYXMoY2xhc3NOYW1lKSkge1xuICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuc2V0KGNsYXNzTmFtZSwgbmV3IE1hcCgpKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICAgIGxldCBzdWJzY3JpcHRpb247XG4gICAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLmhhcyhzdWJzY3JpcHRpb25IYXNoKSkge1xuICAgICAgICBzdWJzY3JpcHRpb24gPSBjbGFzc1N1YnNjcmlwdGlvbnMuZ2V0KHN1YnNjcmlwdGlvbkhhc2gpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc3Vic2NyaXB0aW9uID0gbmV3IFN1YnNjcmlwdGlvbihjbGFzc05hbWUsIHJlcXVlc3QucXVlcnkud2hlcmUsIHN1YnNjcmlwdGlvbkhhc2gpO1xuICAgICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuc2V0KHN1YnNjcmlwdGlvbkhhc2gsIHN1YnNjcmlwdGlvbik7XG4gICAgICB9XG5cbiAgICAgIC8vIEFkZCBzdWJzY3JpcHRpb25JbmZvIHRvIGNsaWVudFxuICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbzogYW55ID0ge1xuICAgICAgICBzdWJzY3JpcHRpb246IHN1YnNjcmlwdGlvbixcbiAgICAgIH07XG4gICAgICAvLyBBZGQgc2VsZWN0ZWQgZmllbGRzLCBzZXNzaW9uVG9rZW4gYW5kIGluc3RhbGxhdGlvbklkIGZvciB0aGlzIHN1YnNjcmlwdGlvbiBpZiBuZWNlc3NhcnlcbiAgICAgIGlmIChyZXF1ZXN0LnF1ZXJ5LmtleXMpIHtcbiAgICAgICAgc3Vic2NyaXB0aW9uSW5mby5rZXlzID0gQXJyYXkuaXNBcnJheShyZXF1ZXN0LnF1ZXJ5LmtleXMpXG4gICAgICAgICAgPyByZXF1ZXN0LnF1ZXJ5LmtleXNcbiAgICAgICAgICA6IHJlcXVlc3QucXVlcnkua2V5cy5zcGxpdCgnLCcpO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3QucXVlcnkud2F0Y2gpIHtcbiAgICAgICAgc3Vic2NyaXB0aW9uSW5mby53YXRjaCA9IHJlcXVlc3QucXVlcnkud2F0Y2g7XG4gICAgICB9XG4gICAgICBpZiAocmVxdWVzdC5zZXNzaW9uVG9rZW4pIHtcbiAgICAgICAgc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4gPSByZXF1ZXN0LnNlc3Npb25Ub2tlbjtcbiAgICAgIH1cbiAgICAgIGNsaWVudC5hZGRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3QucmVxdWVzdElkLCBzdWJzY3JpcHRpb25JbmZvKTtcblxuICAgICAgLy8gQWRkIGNsaWVudElkIHRvIHN1YnNjcmlwdGlvblxuICAgICAgc3Vic2NyaXB0aW9uLmFkZENsaWVudFN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgcmVxdWVzdC5yZXF1ZXN0SWQpO1xuXG4gICAgICBjbGllbnQucHVzaFN1YnNjcmliZShyZXF1ZXN0LnJlcXVlc3RJZCk7XG5cbiAgICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgICBgQ3JlYXRlIGNsaWVudCAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfSBuZXcgc3Vic2NyaXB0aW9uOiAke3JlcXVlc3QucmVxdWVzdElkfWBcbiAgICAgICk7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnQgbnVtYmVyOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcbiAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICBjbGllbnQsXG4gICAgICAgIGV2ZW50OiAnc3Vic2NyaWJlJyxcbiAgICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgICBzZXNzaW9uVG9rZW46IHJlcXVlc3Quc2Vzc2lvblRva2VuLFxuICAgICAgICB1c2VNYXN0ZXJLZXk6IGNsaWVudC5oYXNNYXN0ZXJLZXksXG4gICAgICAgIGluc3RhbGxhdGlvbklkOiBjbGllbnQuaW5zdGFsbGF0aW9uSWQsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIGVycm9yLmNvZGUsIGVycm9yLm1lc3NhZ2UsIGZhbHNlLCByZXF1ZXN0LnJlcXVlc3RJZCk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgIGBGYWlsZWQgcnVubmluZyBiZWZvcmVTdWJzY3JpYmUgb24gJHtjbGFzc05hbWV9IGZvciBzZXNzaW9uICR7cmVxdWVzdC5zZXNzaW9uVG9rZW59IHdpdGg6XFxuIEVycm9yOiBgICtcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShlcnJvcilcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnkpOiBhbnkge1xuICAgIHRoaXMuX2hhbmRsZVVuc3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0LCBmYWxzZSk7XG4gICAgdGhpcy5faGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgfVxuXG4gIF9oYW5kbGVVbnN1YnNjcmliZShwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnksIG5vdGlmeUNsaWVudDogYm9vbGVhbiA9IHRydWUpOiBhbnkge1xuICAgIC8vIElmIHdlIGNhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgcmV0dXJuIGVycm9yIHRvIGNsaWVudFxuICAgIGlmICghT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHBhcnNlV2Vic29ja2V0LCAnY2xpZW50SWQnKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdElkID0gcmVxdWVzdC5yZXF1ZXN0SWQ7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG4gICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0Nhbm5vdCBmaW5kIGNsaWVudCB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnLiBNYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gbGl2ZSBxdWVyeSBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcuJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcignQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50ICcgKyBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvID09PSAndW5kZWZpbmVkJykge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW5ub3QgZmluZCBzdWJzY3JpcHRpb24gd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJyBzdWJzY3JpcHRpb25JZCAnICtcbiAgICAgICAgICByZXF1ZXN0SWQgK1xuICAgICAgICAgICcuIE1ha2Ugc3VyZSB5b3Ugc3Vic2NyaWJlIHRvIGxpdmUgcXVlcnkgc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nLidcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9uIHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcgc3Vic2NyaXB0aW9uSWQgJyArXG4gICAgICAgICAgcmVxdWVzdElkXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFJlbW92ZSBzdWJzY3JpcHRpb24gZnJvbSBjbGllbnRcbiAgICBjbGllbnQuZGVsZXRlU3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIC8vIFJlbW92ZSBjbGllbnQgZnJvbSBzdWJzY3JpcHRpb25cbiAgICBjb25zdCBzdWJzY3JpcHRpb24gPSBzdWJzY3JpcHRpb25JbmZvLnN1YnNjcmlwdGlvbjtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBzdWJzY3JpcHRpb24uY2xhc3NOYW1lO1xuICAgIHN1YnNjcmlwdGlvbi5kZWxldGVDbGllbnRTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIHJlcXVlc3RJZCk7XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xpZW50IHdoaWNoIGlzIHN1YnNjcmliaW5nIHRoaXMgc3Vic2NyaXB0aW9uLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMpIHtcbiAgICAgIGlmICghc3Vic2NyaXB0aW9uLmhhc1N1YnNjcmliaW5nQ2xpZW50KCkpIHtcbiAgICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgICB9XG4gICAgICAvLyBJZiB0aGVyZSBpcyBubyBzdWJzY3JpcHRpb25zIHVuZGVyIHRoaXMgY2xhc3MsIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuc2l6ZSA9PT0gMCkge1xuICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKGNsYXNzTmFtZSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgY2xpZW50LFxuICAgICAgZXZlbnQ6ICd1bnN1YnNjcmliZScsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgc2Vzc2lvblRva2VuOiBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbixcbiAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgIGluc3RhbGxhdGlvbklkOiBjbGllbnQuaW5zdGFsbGF0aW9uSWQsXG4gICAgfSk7XG5cbiAgICBpZiAoIW5vdGlmeUNsaWVudCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNsaWVudC5wdXNoVW5zdWJzY3JpYmUocmVxdWVzdC5yZXF1ZXN0SWQpO1xuXG4gICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICBgRGVsZXRlIGNsaWVudDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH0gfCBzdWJzY3JpcHRpb246ICR7cmVxdWVzdC5yZXF1ZXN0SWR9YFxuICAgICk7XG4gIH1cbn1cblxuZXhwb3J0IHsgUGFyc2VMaXZlUXVlcnlTZXJ2ZXIgfTtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBQUEsSUFBQUEsR0FBQSxHQUFBQyxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUMsS0FBQSxHQUFBRixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQUUsYUFBQSxHQUFBRixPQUFBO0FBQ0EsSUFBQUcsT0FB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