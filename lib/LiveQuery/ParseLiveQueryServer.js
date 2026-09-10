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
        this.authCache.set(sessionToken, Promise.resolve(result), this.config.cacheTimeout);
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
      const result = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);
      userId = result.userId;
      if (userId) {
        aclGroup.push(userId);
      }
    }
    await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
    // Enforce pointer permissions that validatePermission defers.
    // Returns false to silently skip the event (like ACL), rather than
    // throwing which would push errors to the client and log noise.
    if (!client.hasMasterKey && classLevelPermissions) {
      const permissionField = ['get', 'find', 'count'].indexOf(op) > -1 ? 'readUserFields' : 'writeUserFields';
      const pointerFields = [];
      if (classLevelPermissions[op]?.pointerFields) {
        pointerFields.push(...classLevelPermissions[op].pointerFields);
      }
      if (Array.isArray(classLevelPermissions[permissionField])) {
        for (const field of classLevelPermissions[permissionField]) {
          if (!pointerFields.includes(field)) {
            pointerFields.push(field);
          }
        }
      }
      if (pointerFields.length > 0) {
        // If public or user-specific permission already grants access, skip pointer check
        if (!_SchemaController.default.testPermissions(classLevelPermissions, aclGroup, op)) {
          if (!userId) {
            return false;
          }
          // Check if any pointer field points to the current user
          const hasAccess = pointerFields.some(field => {
            const value = typeof object.get === 'function' ? object.get(field) : object[field];
            if (!value) {
              return false;
            }
            // Handle Parse.Object pointer (has .id)
            if (value.id) {
              return value.id === userId;
            }
            // Handle raw pointer JSON (has .objectId)
            if (value.objectId) {
              return value.objectId === userId;
            }
            // Handle array of pointers
            if (Array.isArray(value)) {
              return value.some(item => {
                if (item.id) {
                  return item.id === userId;
                }
                if (item.objectId) {
                  return item.objectId === userId;
                }
                return false;
              });
            }
            return false;
          });
          if (!hasAccess) {
            return false;
          }
        }
      }
    }
  }
  async _filterSensitiveData(classLevelPermissions, res, client, requestId, op, query) {
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let clientAuth;
    if (typeof subscriptionInfo !== 'undefined') {
      const {
        userId,
        auth
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);
      if (userId) {
        aclGroup.push(userId);
      }
      clientAuth = auth;
    }
    const filter = obj => {
      if (!obj) {
        return;
      }
      let protectedFields = classLevelPermissions?.protectedFields || [];
      if (client.hasMasterKey) {
        protectedFields = [];
      } else if (!Array.isArray(protectedFields)) {
        protectedFields = (0, _Controllers.getDatabaseController)(this.config).addProtectedFields(classLevelPermissions, res.object.className, query, aclGroup, clientAuth);
      }
      return _DatabaseController.default.filterSensitiveData(client.hasMasterKey, false, aclGroup, clientAuth, op, classLevelPermissions, res.object.className, protectedFields, obj, this.config.protectedFieldsOwnerExempt);
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
    try {
      const trigger = (0, _triggers.getTrigger)(className, 'beforeSubscribe', _node.default.applicationId);
      if (trigger) {
        const auth = await this.getAuthFromClient(client, request.requestId, request.sessionToken);
        authCalled = true;
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
        if (auth && auth.user) {
          request.user = auth.user;
          aclGroup.push(auth.user.id);
        }
      } else if (request.user) {
        aclGroup.push(request.user.id);
      }
      await _SchemaController.default.validatePermission(classLevelPermissions, className, aclGroup, op);

      // Check protected fields in WHERE clause and WATCH parameter
      if (!client.hasMasterKey) {
        const auth = request.user ? {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfdHYiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwicmVxdWlyZSIsIl9ub2RlIiwiX1N1YnNjcmlwdGlvbiIsIl9DbGllbnQiLCJfUGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJfbG9nZ2VyIiwiX1JlcXVlc3RTY2hlbWEiLCJfUXVlcnlUb29scyIsIl9QYXJzZVB1YlN1YiIsIl9TY2hlbWFDb250cm9sbGVyIiwiX2xvZGFzaCIsIl9jcnlwdG8iLCJfdHJpZ2dlcnMiLCJfQXV0aCIsIl9Db250cm9sbGVycyIsIl9Db25maWciLCJfbHJ1Q2FjaGUiLCJfVXNlcnNSb3V0ZXIiLCJfRGF0YWJhc2VDb250cm9sbGVyIiwiX3V0aWwiLCJlIiwiX19lc01vZHVsZSIsImRlZmF1bHQiLCJQYXJzZUxpdmVRdWVyeVNlcnZlciIsImNvbnN0cnVjdG9yIiwic2VydmVyIiwiY29uZmlnIiwicGFyc2VTZXJ2ZXJDb25maWciLCJjbGllbnRzIiwiTWFwIiwic3Vic2NyaXB0aW9ucyIsImFwcElkIiwiUGFyc2UiLCJhcHBsaWNhdGlvbklkIiwibWFzdGVyS2V5Iiwia2V5UGFpcnMiLCJrZXkiLCJPYmplY3QiLCJrZXlzIiwic2V0IiwibG9nZ2VyIiwidmVyYm9zZSIsImRpc2FibGVTaW5nbGVJbnN0YW5jZSIsInNlcnZlclVSTCIsImluaXRpYWxpemUiLCJqYXZhU2NyaXB0S2V5IiwiY2FjaGVDb250cm9sbGVyIiwiZ2V0Q2FjaGVDb250cm9sbGVyIiwiY2FjaGVUaW1lb3V0IiwiYXV0aENhY2hlIiwiTFJVIiwibWF4IiwidHRsIiwicGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJQYXJzZVdlYlNvY2tldFNlcnZlciIsInBhcnNlV2Vic29ja2V0IiwiX29uQ29ubmVjdCIsInN1YnNjcmliZXIiLCJQYXJzZVB1YlN1YiIsImNyZWF0ZVN1YnNjcmliZXIiLCJjb25uZWN0IiwiaXNPcGVuIiwiUHJvbWlzZSIsInJlc29sdmUiLCJfY3JlYXRlU3Vic2NyaWJlcnMiLCJzaHV0ZG93biIsImFsbCIsInZhbHVlcyIsIm1hcCIsImNsaWVudCIsInBhcnNlV2ViU29ja2V0Iiwid3MiLCJjbG9zZSIsIkFycmF5IiwiZnJvbSIsInVuc3Vic2NyaWJlIiwiZXJyIiwiZXJyb3IiLCJtZXNzYWdlUmVjaWV2ZWQiLCJjaGFubmVsIiwibWVzc2FnZVN0ciIsIm1lc3NhZ2UiLCJKU09OIiwicGFyc2UiLCJfY2xlYXJDYWNoZWRSb2xlcyIsInVzZXJJZCIsIl9pbmZsYXRlUGFyc2VPYmplY3QiLCJfb25BZnRlclNhdmUiLCJfb25BZnRlckRlbGV0ZSIsIm9uIiwiZmllbGQiLCJzdWJzY3JpYmUiLCJjdXJyZW50UGFyc2VPYmplY3QiLCJVc2VyUm91dGVyIiwicmVtb3ZlSGlkZGVuUHJvcGVydGllcyIsImNsYXNzTmFtZSIsInBhcnNlT2JqZWN0IiwiX2ZpbmlzaEZldGNoIiwib3JpZ2luYWxQYXJzZU9iamVjdCIsImRlbGV0ZWRQYXJzZU9iamVjdCIsInRvSlNPTiIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlkIiwic2l6ZSIsImNsYXNzU3Vic2NyaXB0aW9ucyIsImdldCIsImRlYnVnIiwic3Vic2NyaXB0aW9uIiwiaXNTdWJzY3JpcHRpb25NYXRjaGVkIiwiX21hdGNoZXNTdWJzY3JpcHRpb24iLCJjbGllbnRJZCIsInJlcXVlc3RJZHMiLCJfIiwiZW50cmllcyIsImNsaWVudFJlcXVlc3RJZHMiLCJmb3JFYWNoIiwicmVxdWVzdElkIiwibG9jYWxEZWxldGVkUGFyc2VPYmplY3QiLCJzdHJpbmdpZnkiLCJhY2wiLCJnZXRBQ0wiLCJvcCIsIl9nZXRDTFBPcGVyYXRpb24iLCJxdWVyeSIsInJlcyIsIm1hdGNoZXNDTFAiLCJfbWF0Y2hlc0NMUCIsImlzTWF0Y2hlZCIsIl9tYXRjaGVzQUNMIiwiZXZlbnQiLCJzZXNzaW9uVG9rZW4iLCJvYmplY3QiLCJ1c2VNYXN0ZXJLZXkiLCJoYXNNYXN0ZXJLZXkiLCJpbnN0YWxsYXRpb25JZCIsInNlbmRFdmVudCIsInRyaWdnZXIiLCJnZXRUcmlnZ2VyIiwiYXV0aCIsImdldEF1dGhGcm9tQ2xpZW50IiwidXNlciIsImZyb21KU09OIiwicnVuVHJpZ2dlciIsInRvSlNPTndpdGhPYmplY3RzIiwiX2ZpbHRlclNlbnNpdGl2ZURhdGEiLCJwdXNoRGVsZXRlIiwicmVzb2x2ZUVycm9yIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiY29kZSIsImlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkIiwiaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCIsImxvY2FsQ3VycmVudFBhcnNlT2JqZWN0IiwibG9jYWxPcmlnaW5hbFBhcnNlT2JqZWN0Iiwib3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UiLCJvcmlnaW5hbEFDTCIsImN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UiLCJjdXJyZW50QUNMIiwiaXNPcmlnaW5hbE1hdGNoZWQiLCJpc0N1cnJlbnRNYXRjaGVkIiwiaGFzaCIsInR5cGUiLCJ3YXRjaEZpZWxkc0NoYW5nZWQiLCJfY2hlY2tXYXRjaEZpZWxkcyIsImN1cnJlbnRSZWFkYWJsZSIsIm9yaWdpbmFsUmVhZGFibGUiLCJvcmlnaW5hbCIsImZ1bmN0aW9uTmFtZSIsImNoYXJBdCIsInRvVXBwZXJDYXNlIiwic2xpY2UiLCJyZXF1ZXN0IiwidHY0IiwidmFsaWRhdGUiLCJSZXF1ZXN0U2NoZW1hIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIiwiZGVsZXRlIiwic3Vic2NyaXB0aW9uSW5mbyIsInN1YnNjcmlwdGlvbkluZm9zIiwiZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uIiwiaGFzU3Vic2NyaWJpbmdDbGllbnQiLCJfdmFsaWRhdGVRdWVyeUNvbnN0cmFpbnRzIiwid2hlcmUiLCJ1bmRlZmluZWQiLCJpc0FycmF5IiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwic3ViUXVlcnkiLCJjb25zdHJhaW50IiwiJHJlZ2V4IiwicmVnZXgiLCJpc1JlZ0V4cExpa2UiLCJzb3VyY2UiLCJmbGFncyIsInBhdHRlcm4iLCIkb3B0aW9ucyIsIlJlZ0V4cCIsIm1hdGNoZXNRdWVyeSIsInN0cnVjdHVyZWRDbG9uZSIsInZhbGlkVG9rZW5zIiwiUXVlcnkiLCJTZXNzaW9uIiwiZXF1YWxUbyIsIlVzZXIiLCJjcmVhdGVXaXRob3V0RGF0YSIsImZpbmQiLCJ0b2tlbiIsImF1dGhQcm9taXNlIiwiYXV0aDEiLCJhdXRoMiIsImdldEF1dGhGb3JTZXNzaW9uVG9rZW4iLCJjbGVhclJvbGVDYWNoZSIsImZyb21DYWNoZSIsInRoZW4iLCJjYXRjaCIsInJlc3VsdCIsIklOVkFMSURfU0VTU0lPTl9UT0tFTiIsImdldFN1YnNjcmlwdGlvbkluZm8iLCJhY2xHcm91cCIsInB1c2giLCJTY2hlbWFDb250cm9sbGVyIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwicGVybWlzc2lvbkZpZWxkIiwiaW5kZXhPZiIsInBvaW50ZXJGaWVsZHMiLCJpbmNsdWRlcyIsImxlbmd0aCIsInRlc3RQZXJtaXNzaW9ucyIsImhhc0FjY2VzcyIsInNvbWUiLCJ2YWx1ZSIsIm9iamVjdElkIiwiaXRlbSIsImNsaWVudEF1dGgiLCJmaWx0ZXIiLCJvYmoiLCJwcm90ZWN0ZWRGaWVsZHMiLCJnZXREYXRhYmFzZUNvbnRyb2xsZXIiLCJhZGRQcm90ZWN0ZWRGaWVsZHMiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJmaWx0ZXJTZW5zaXRpdmVEYXRhIiwicHJvdGVjdGVkRmllbGRzT3duZXJFeGVtcHQiLCJfdmVyaWZ5QUNMIiwiaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkIiwiZ2V0UmVhZEFjY2VzcyIsImFjbF9oYXNfcm9sZXMiLCJwZXJtaXNzaW9uc0J5SWQiLCJzdGFydHNXaXRoIiwicm9sZU5hbWVzIiwiZ2V0VXNlclJvbGVzIiwicm9sZSIsImdldFNlc3Npb25Gcm9tQ2xpZW50Iiwid2F0Y2giLCJpc0RlZXBTdHJpY3RFcXVhbCIsImdldFB1YmxpY1JlYWRBY2Nlc3MiLCJzdWJzY3JpcHRpb25Ub2tlbiIsImNsaWVudFNlc3Npb25Ub2tlbiIsIl92YWxpZGF0ZUtleXMiLCJfaGFzTWFzdGVyS2V5IiwicmFuZG9tVVVJRCIsInJlcSIsInB1c2hDb25uZWN0IiwidmFsaWRLZXlQYWlycyIsInByb3RvdHlwZSIsImhhc093blByb3BlcnR5IiwiY2FsbCIsImlzVmFsaWQiLCJzZWNyZXQiLCJhdXRoQ2FsbGVkIiwicGFyc2VRdWVyeSIsIndpdGhKU09OIiwidG9Qb2ludGVyIiwibWFzdGVyIiwiYXBwQ29uZmlnIiwiQ29uZmlnIiwicmMiLCJyZXF1ZXN0Q29tcGxleGl0eSIsInF1ZXJ5RGVwdGgiLCJtYXhEZXB0aCIsImNoZWNrRGVwdGgiLCJub2RlIiwiZGVwdGgiLCJpc0xvZ2ljYWwiLCJhbGxvd1JlZ2V4IiwiY2hlY2tSZWdleCIsInNjaGVtYUNvbnRyb2xsZXIiLCJkYXRhYmFzZSIsImxvYWRTY2hlbWEiLCJnZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJ1c2VyUm9sZXMiLCJjaGVja1doZXJlIiwid2hlcmVLZXkiLCJyb290RmllbGQiLCJzcGxpdCIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJ3YXRjaEZpZWxkIiwicHJldmlvdXNTdWJzY3JpcHRpb25JbmZvIiwicHJldmlvdXNTdWJzY3JpcHRpb24iLCJwcmV2aW91c0NsYXNzU3Vic2NyaXB0aW9ucyIsInN1YnNjcmlwdGlvbkhhc2giLCJxdWVyeUhhc2giLCJTdWJzY3JpcHRpb24iLCJhZGRTdWJzY3JpcHRpb25JbmZvIiwiYWRkQ2xpZW50U3Vic2NyaXB0aW9uIiwicHVzaFN1YnNjcmliZSIsIm5vdGlmeUNsaWVudCIsImRlbGV0ZVN1YnNjcmlwdGlvbkluZm8iLCJwdXNoVW5zdWJzY3JpYmUiLCJleHBvcnRzIl0sInNvdXJjZXMiOlsiLi4vLi4vc3JjL0xpdmVRdWVyeS9QYXJzZUxpdmVRdWVyeVNlcnZlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHY0IGZyb20gJ3R2NCc7XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG5pbXBvcnQgeyBTdWJzY3JpcHRpb24gfSBmcm9tICcuL1N1YnNjcmlwdGlvbic7XG5pbXBvcnQgeyBDbGllbnQgfSBmcm9tICcuL0NsaWVudCc7XG5pbXBvcnQgeyBQYXJzZVdlYlNvY2tldFNlcnZlciB9IGZyb20gJy4vUGFyc2VXZWJTb2NrZXRTZXJ2ZXInO1xuLy8gQHRzLWlnbm9yZVxuaW1wb3J0IGxvZ2dlciBmcm9tICcuLi9sb2dnZXInO1xuaW1wb3J0IFJlcXVlc3RTY2hlbWEgZnJvbSAnLi9SZXF1ZXN0U2NoZW1hJztcbmltcG9ydCB7IG1hdGNoZXNRdWVyeSwgcXVlcnlIYXNoIH0gZnJvbSAnLi9RdWVyeVRvb2xzJztcbmltcG9ydCB7IFBhcnNlUHViU3ViIH0gZnJvbSAnLi9QYXJzZVB1YlN1Yic7XG5pbXBvcnQgU2NoZW1hQ29udHJvbGxlciBmcm9tICcuLi9Db250cm9sbGVycy9TY2hlbWFDb250cm9sbGVyJztcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7XG4gIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMsXG4gIGdldFRyaWdnZXIsXG4gIHJ1blRyaWdnZXIsXG4gIHJlc29sdmVFcnJvcixcbiAgdG9KU09Od2l0aE9iamVjdHMsXG59IGZyb20gJy4uL3RyaWdnZXJzJztcbmltcG9ydCB7IGdldEF1dGhGb3JTZXNzaW9uVG9rZW4sIEF1dGggfSBmcm9tICcuLi9BdXRoJztcbmltcG9ydCB7IGdldENhY2hlQ29udHJvbGxlciwgZ2V0RGF0YWJhc2VDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuLi9Db25maWcnO1xuaW1wb3J0IHsgTFJVQ2FjaGUgYXMgTFJVIH0gZnJvbSAnbHJ1LWNhY2hlJztcbmltcG9ydCBVc2VyUm91dGVyIGZyb20gJy4uL1JvdXRlcnMvVXNlcnNSb3V0ZXInO1xuaW1wb3J0IERhdGFiYXNlQ29udHJvbGxlciBmcm9tICcuLi9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXInO1xuaW1wb3J0IHsgaXNEZWVwU3RyaWN0RXF1YWwgfSBmcm9tICd1dGlsJztcblxuXG5jbGFzcyBQYXJzZUxpdmVRdWVyeVNlcnZlciB7XG4gIHNlcnZlcjogYW55O1xuICBjb25maWc6IGFueTtcbiAgY2xpZW50czogTWFwPHN0cmluZywgYW55PjtcbiAgLy8gY2xhc3NOYW1lIC0+IChxdWVyeUhhc2ggLT4gc3Vic2NyaXB0aW9uKVxuICBzdWJzY3JpcHRpb25zOiBNYXA8c3RyaW5nLCBhbnk+O1xuICBwYXJzZVdlYlNvY2tldFNlcnZlcjogYW55O1xuICBrZXlQYWlyczogYW55O1xuICAvLyBUaGUgc3Vic2NyaWJlciB3ZSB1c2UgdG8gZ2V0IG9iamVjdCB1cGRhdGUgZnJvbSBwdWJsaXNoZXJcbiAgc3Vic2NyaWJlcjogYW55O1xuICBhdXRoQ2FjaGU6IGFueTtcbiAgY2FjaGVDb250cm9sbGVyOiBhbnk7XG5cbiAgY29uc3RydWN0b3Ioc2VydmVyOiBhbnksIGNvbmZpZzogYW55ID0ge30sIHBhcnNlU2VydmVyQ29uZmlnOiBhbnkgPSB7fSkge1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuICAgIHRoaXMuY2xpZW50cyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5jb25maWcgPSBjb25maWc7XG5cbiAgICBjb25maWcuYXBwSWQgPSBjb25maWcuYXBwSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgICBjb25maWcubWFzdGVyS2V5ID0gY29uZmlnLm1hc3RlcktleSB8fCBQYXJzZS5tYXN0ZXJLZXk7XG5cbiAgICAvLyBTdG9yZSBrZXlzLCBjb252ZXJ0IG9iaiB0byBtYXBcbiAgICBjb25zdCBrZXlQYWlycyA9IGNvbmZpZy5rZXlQYWlycyB8fCB7fTtcbiAgICB0aGlzLmtleVBhaXJzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGtleVBhaXJzKSkge1xuICAgICAgdGhpcy5rZXlQYWlycy5zZXQoa2V5LCBrZXlQYWlyc1trZXldKTtcbiAgICB9XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ1N1cHBvcnQga2V5IHBhaXJzJywgdGhpcy5rZXlQYWlycyk7XG5cbiAgICAvLyBJbml0aWFsaXplIFBhcnNlXG4gICAgUGFyc2UuT2JqZWN0LmRpc2FibGVTaW5nbGVJbnN0YW5jZSgpO1xuICAgIGNvbnN0IHNlcnZlclVSTCA9IGNvbmZpZy5zZXJ2ZXJVUkwgfHwgUGFyc2Uuc2VydmVyVVJMO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcbiAgICBQYXJzZS5pbml0aWFsaXplKGNvbmZpZy5hcHBJZCwgUGFyc2UuamF2YVNjcmlwdEtleSwgY29uZmlnLm1hc3RlcktleSk7XG5cbiAgICAvLyBUaGUgY2FjaGUgY29udHJvbGxlciBpcyBhIHByb3BlciBjYWNoZSBjb250cm9sbGVyXG4gICAgLy8gd2l0aCBhY2Nlc3MgdG8gVXNlciBhbmQgUm9sZXNcbiAgICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGdldENhY2hlQ29udHJvbGxlcihwYXJzZVNlcnZlckNvbmZpZyk7XG5cbiAgICBjb25maWcuY2FjaGVUaW1lb3V0ID0gY29uZmlnLmNhY2hlVGltZW91dCB8fCA1ICogMTAwMDsgLy8gNXNcblxuICAgIC8vIFRoaXMgYXV0aCBjYWNoZSBzdG9yZXMgdGhlIHByb21pc2VzIGZvciBlYWNoIGF1dGggcmVzb2x1dGlvbi5cbiAgICAvLyBUaGUgbWFpbiBiZW5lZml0IGlzIHRvIGJlIGFibGUgdG8gcmV1c2UgdGhlIHNhbWUgdXNlciAvIHNlc3Npb24gdG9rZW4gcmVzb2x1dGlvbi5cbiAgICB0aGlzLmF1dGhDYWNoZSA9IG5ldyBMUlUoe1xuICAgICAgbWF4OiA1MDAsIC8vIDUwMCBjb25jdXJyZW50XG4gICAgICB0dGw6IGNvbmZpZy5jYWNoZVRpbWVvdXQsXG4gICAgfSk7XG4gICAgLy8gSW5pdGlhbGl6ZSB3ZWJzb2NrZXQgc2VydmVyXG4gICAgdGhpcy5wYXJzZVdlYlNvY2tldFNlcnZlciA9IG5ldyBQYXJzZVdlYlNvY2tldFNlcnZlcihcbiAgICAgIHNlcnZlcixcbiAgICAgIHBhcnNlV2Vic29ja2V0ID0+IHRoaXMuX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldCksXG4gICAgICBjb25maWdcbiAgICApO1xuICAgIHRoaXMuc3Vic2NyaWJlciA9IFBhcnNlUHViU3ViLmNyZWF0ZVN1YnNjcmliZXIoY29uZmlnKTtcbiAgICBpZiAoIXRoaXMuc3Vic2NyaWJlci5jb25uZWN0KSB7XG4gICAgICB0aGlzLmNvbm5lY3QoKTtcbiAgICB9XG4gIH1cblxuICBhc3luYyBjb25uZWN0KCkge1xuICAgIGlmICh0aGlzLnN1YnNjcmliZXIuaXNPcGVuKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0eXBlb2YgdGhpcy5zdWJzY3JpYmVyLmNvbm5lY3QgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGF3YWl0IFByb21pc2UucmVzb2x2ZSh0aGlzLnN1YnNjcmliZXIuY29ubmVjdCgpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdWJzY3JpYmVyLmlzT3BlbiA9IHRydWU7XG4gICAgfVxuICAgIHRoaXMuX2NyZWF0ZVN1YnNjcmliZXJzKCk7XG4gIH1cblxuICBhc3luYyBzaHV0ZG93bigpIHtcbiAgICBpZiAodGhpcy5zdWJzY3JpYmVyLmlzT3Blbikge1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAuLi5bLi4udGhpcy5jbGllbnRzLnZhbHVlcygpXS5tYXAoY2xpZW50ID0+IGNsaWVudC5wYXJzZVdlYlNvY2tldC53cy5jbG9zZSgpKSxcbiAgICAgICAgdGhpcy5wYXJzZVdlYlNvY2tldFNlcnZlci5jbG9zZT8uKCksXG4gICAgICAgIC4uLkFycmF5LmZyb20odGhpcy5zdWJzY3JpYmVyLnN1YnNjcmlwdGlvbnM/LmtleXMoKSB8fCBbXSkubWFwKGtleSA9PlxuICAgICAgICAgIHRoaXMuc3Vic2NyaWJlci51bnN1YnNjcmliZShrZXkpXG4gICAgICAgICksXG4gICAgICAgIHRoaXMuc3Vic2NyaWJlci5jbG9zZT8uKCksXG4gICAgICBdKTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiB0aGlzLnN1YnNjcmliZXIuY2xvc2UgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHRoaXMuc3Vic2NyaWJlci5jbG9zZSgpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcignUHViU3ViQWRhcHRlciBlcnJvciBvbiBzaHV0ZG93bicsIHsgZXJyb3I6IGVyciB9KTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdWJzY3JpYmVyLmlzT3BlbiA9IGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIF9jcmVhdGVTdWJzY3JpYmVycygpIHtcbiAgICBjb25zdCBtZXNzYWdlUmVjaWV2ZWQgPSAoY2hhbm5lbCwgbWVzc2FnZVN0cikgPT4ge1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ1N1YnNjcmliZSBtZXNzYWdlICVqJywgbWVzc2FnZVN0cik7XG4gICAgICBsZXQgbWVzc2FnZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1lc3NhZ2UgPSBKU09OLnBhcnNlKG1lc3NhZ2VTdHIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSBtZXNzYWdlJywgbWVzc2FnZVN0ciwgZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2NsZWFyQ2FjaGUnKSB7XG4gICAgICAgIHRoaXMuX2NsZWFyQ2FjaGVkUm9sZXMobWVzc2FnZS51c2VySWQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLl9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZSk7XG4gICAgICBpZiAoY2hhbm5lbCA9PT0gUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJTYXZlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlJykge1xuICAgICAgICB0aGlzLl9vbkFmdGVyRGVsZXRlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdHZXQgbWVzc2FnZSAlcyBmcm9tIHVua25vd24gY2hhbm5lbCAlaicsIG1lc3NhZ2UsIGNoYW5uZWwpO1xuICAgICAgfVxuICAgIH07XG4gICAgdGhpcy5zdWJzY3JpYmVyLm9uKCdtZXNzYWdlJywgKGNoYW5uZWwsIG1lc3NhZ2VTdHIpID0+IG1lc3NhZ2VSZWNpZXZlZChjaGFubmVsLCBtZXNzYWdlU3RyKSk7XG4gICAgZm9yIChjb25zdCBmaWVsZCBvZiBbJ2FmdGVyU2F2ZScsICdhZnRlckRlbGV0ZScsICdjbGVhckNhY2hlJ10pIHtcbiAgICAgIGNvbnN0IGNoYW5uZWwgPSBgJHtQYXJzZS5hcHBsaWNhdGlvbklkfSR7ZmllbGR9YDtcbiAgICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoY2hhbm5lbCwgbWVzc2FnZVN0ciA9PiBtZXNzYWdlUmVjaWV2ZWQoY2hhbm5lbCwgbWVzc2FnZVN0cikpO1xuICAgIH1cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgSlNPTiBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0IEpTT04uXG4gIF9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgLy8gSW5mbGF0ZSBtZXJnZWQgb2JqZWN0XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgVXNlclJvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbGV0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbGV0IHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgIHBhcnNlT2JqZWN0Ll9maW5pc2hGZXRjaChjdXJyZW50UGFyc2VPYmplY3QpO1xuICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgLy8gSW5mbGF0ZSBvcmlnaW5hbCBvYmplY3RcbiAgICBjb25zdCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0O1xuICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBVc2VyUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBjbGFzc05hbWUgPSBvcmlnaW5hbFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICAgIHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKG9yaWdpbmFsUGFyc2VPYmplY3QpO1xuICAgICAgbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBhc3luYyBfb25BZnRlckRlbGV0ZShtZXNzYWdlOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgbGV0IGRlbGV0ZWRQYXJzZU9iamVjdCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LnRvSlNPTigpO1xuICAgIGNvbnN0IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyA9IG1lc3NhZ2UuY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IGRlbGV0ZWRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0NsYXNzTmFtZTogJWogfCBPYmplY3RJZDogJXMnLCBjbGFzc05hbWUsIGRlbGV0ZWRQYXJzZU9iamVjdC5pZCk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAoY29uc3Qgc3Vic2NyaXB0aW9uIG9mIGNsYXNzU3Vic2NyaXB0aW9ucy52YWx1ZXMoKSkge1xuICAgICAgbGV0IGlzU3Vic2NyaXB0aW9uTWF0Y2hlZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlzU3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oZGVsZXRlZFBhcnNlT2JqZWN0LCBzdWJzY3JpcHRpb24pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoYEZhaWxlZCBtYXRjaGluZyBzdWJzY3JpcHRpb24gZm9yIGNsYXNzICR7Y2xhc3NOYW1lfTogJHtlLm1lc3NhZ2V9YCk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKCFpc1N1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKHN1YnNjcmlwdGlvbi5jbGllbnRSZXF1ZXN0SWRzKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmVxdWVzdElkcy5mb3JFYWNoKGFzeW5jIHJlcXVlc3RJZCA9PiB7XG4gICAgICAgICAgLy8gRGVlcC1jbG9uZSBzaGFyZWQgb2JqZWN0IHNvIGVhY2ggY29uY3VycmVudCBjYWxsYmFjayB3b3JrcyBvbiBpdHMgb3duIGNvcHlcbiAgICAgICAgICBsZXQgbG9jYWxEZWxldGVkUGFyc2VPYmplY3QgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGRlbGV0ZWRQYXJzZU9iamVjdCkpO1xuICAgICAgICAgIGNvbnN0IGFjbCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgIC8vIENoZWNrIENMUFxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgbGV0IHJlczogYW55ID0ge307XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IG1hdGNoZXNDTFAgPSBhd2FpdCB0aGlzLl9tYXRjaGVzQ0xQKFxuICAgICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBjbGllbnQsXG4gICAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgICAgb3BcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAobWF0Y2hlc0NMUCA9PT0gZmFsc2UpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpc01hdGNoZWQgPSBhd2FpdCB0aGlzLl9tYXRjaGVzQUNMKGFjbCwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgaWYgKCFpc01hdGNoZWQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXMgPSB7XG4gICAgICAgICAgICAgIGV2ZW50OiAnZGVsZXRlJyxcbiAgICAgICAgICAgICAgc2Vzc2lvblRva2VuOiBjbGllbnQuc2Vzc2lvblRva2VuLFxuICAgICAgICAgICAgICBvYmplY3Q6IGxvY2FsRGVsZXRlZFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgICAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgICAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGNsaWVudC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgICAgICAgc2VuZEV2ZW50OiB0cnVlLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgJ2FmdGVyRXZlbnQnLCBQYXJzZS5hcHBsaWNhdGlvbklkKTtcbiAgICAgICAgICAgIGlmICh0cmlnZ2VyKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KGNsaWVudCwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgICAgICAgcmVzLnVzZXIgPSBhdXRoLnVzZXI7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKHJlcy5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXMub2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcy5vYmplY3QpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IHJ1blRyaWdnZXIodHJpZ2dlciwgYGFmdGVyRXZlbnQuJHtjbGFzc05hbWV9YCwgcmVzLCBhdXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghcmVzLnNlbmRFdmVudCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9iamVjdCAmJiB0eXBlb2YgcmVzLm9iamVjdC50b0pTT04gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgbG9jYWxEZWxldGVkUGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhyZXMub2JqZWN0LCByZXMub2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmVzLm9iamVjdCA9IGxvY2FsRGVsZXRlZFBhcnNlT2JqZWN0O1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5fZmlsdGVyU2Vuc2l0aXZlRGF0YShcbiAgICAgICAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgICByZXMsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgICBvcCxcbiAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uLnF1ZXJ5XG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgY2xpZW50LnB1c2hEZWxldGUocmVxdWVzdElkLCByZXMub2JqZWN0KTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IoY2xpZW50LnBhcnNlV2ViU29ja2V0LCBlcnJvci5jb2RlLCBlcnJvci5tZXNzYWdlLCBmYWxzZSwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGFmdGVyTGl2ZVF1ZXJ5RXZlbnQgb24gY2xhc3MgJHtjbGFzc05hbWV9IGZvciBldmVudCAke3Jlcy5ldmVudH0gd2l0aCBzZXNzaW9uICR7cmVzLnNlc3Npb25Ub2tlbn0gd2l0aDpcXG4gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyIGFmdGVyIGluZmxhdGVkLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgYWZ0ZXIgY2hhbmdlcy5cbiAgLy8gTWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0IGlzIHRoZSBvcmlnaW5hbCBQYXJzZU9iamVjdC5cbiAgYXN5bmMgX29uQWZ0ZXJTYXZlKG1lc3NhZ2U6IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxvZ2dlci52ZXJib3NlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJTYXZlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgbGV0IG9yaWdpbmFsUGFyc2VPYmplY3QgPSBudWxsO1xuICAgIGlmIChtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgfVxuICAgIGNvbnN0IGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyA9IG1lc3NhZ2UuY2xhc3NMZXZlbFBlcm1pc3Npb25zO1xuICAgIGxldCBjdXJyZW50UGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBjdXJyZW50UGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDbGFzc05hbWU6ICVzIHwgT2JqZWN0SWQ6ICVzJywgY2xhc3NOYW1lLCBjdXJyZW50UGFyc2VPYmplY3QuaWQpO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudCBudW1iZXIgOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcblxuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAodHlwZW9mIGNsYXNzU3Vic2NyaXB0aW9ucyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZygnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcyAnICsgY2xhc3NOYW1lKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzdWJzY3JpcHRpb24gb2YgY2xhc3NTdWJzY3JpcHRpb25zLnZhbHVlcygpKSB7XG4gICAgICBsZXQgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQ7XG4gICAgICBsZXQgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICAgIHN1YnNjcmlwdGlvblxuICAgICAgICApO1xuICAgICAgICBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgICBjdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgRmFpbGVkIG1hdGNoaW5nIHN1YnNjcmlwdGlvbiBmb3IgY2xhc3MgJHtjbGFzc05hbWV9OiAke2UubWVzc2FnZX1gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKHN1YnNjcmlwdGlvbi5jbGllbnRSZXF1ZXN0SWRzKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmVxdWVzdElkcy5mb3JFYWNoKGFzeW5jIHJlcXVlc3RJZCA9PiB7XG4gICAgICAgICAgLy8gRGVlcC1jbG9uZSBzaGFyZWQgb2JqZWN0cyBzbyBlYWNoIGNvbmN1cnJlbnQgY2FsbGJhY2sgd29ya3Mgb24gaXRzIG93biBjb3B5LlxuICAgICAgICAgIC8vIFdpdGhvdXQgY2xvbmluZywgX2ZpbHRlclNlbnNpdGl2ZURhdGEncyBpbi1wbGFjZSBmaWVsZCBkZWxldGlvbiBhbmQgYWZ0ZXJFdmVudFxuICAgICAgICAgIC8vIHRyaWdnZXIgbW9kaWZpY2F0aW9ucyBjb3JydXB0IHRoZSBzaGFyZWQgc3RhdGUgYWNyb3NzIGNvbmN1cnJlbnQgc3Vic2NyaWJlcnMuXG4gICAgICAgICAgbGV0IGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShjdXJyZW50UGFyc2VPYmplY3QpKTtcbiAgICAgICAgICBsZXQgbG9jYWxPcmlnaW5hbFBhcnNlT2JqZWN0ID0gb3JpZ2luYWxQYXJzZU9iamVjdFxuICAgICAgICAgICAgPyBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KG9yaWdpbmFsUGFyc2VPYmplY3QpKVxuICAgICAgICAgICAgOiBudWxsO1xuICAgICAgICAgIC8vIFNldCBvcmlnbmFsIFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCkge1xuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgb3JpZ2luYWxBQ0w7XG4gICAgICAgICAgICBpZiAobWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgIG9yaWdpbmFsQUNMID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb3JpZ2luYWxBQ0xDaGVja2luZ1Byb21pc2UgPSB0aGlzLl9tYXRjaGVzQUNMKG9yaWdpbmFsQUNMLCBjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFNldCBjdXJyZW50IFBhcnNlT2JqZWN0IEFDTCBjaGVja2luZyBwcm9taXNlLCBpZiB0aGUgb2JqZWN0IGRvZXMgbm90IG1hdGNoXG4gICAgICAgICAgLy8gc3Vic2NyaXB0aW9uLCB3ZSBkbyBub3QgbmVlZCB0byBjaGVjayBBQ0xcbiAgICAgICAgICBsZXQgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZTtcbiAgICAgICAgICBsZXQgcmVzOiBhbnkgPSB7fTtcbiAgICAgICAgICBpZiAoIWlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UgPSBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBjdXJyZW50QUNMID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QuZ2V0QUNMKCk7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChjdXJyZW50QUNMLCBjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBvcCA9IHRoaXMuX2dldENMUE9wZXJhdGlvbihzdWJzY3JpcHRpb24ucXVlcnkpO1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlc0NMUCA9IGF3YWl0IHRoaXMuX21hdGNoZXNDTFAoXG4gICAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgICAgbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgICBvcFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmIChtYXRjaGVzQ0xQID09PSBmYWxzZSkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBbaXNPcmlnaW5hbE1hdGNoZWQsIGlzQ3VycmVudE1hdGNoZWRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgbG9nZ2VyLnZlcmJvc2UoXG4gICAgICAgICAgICAgICdPcmlnaW5hbCAlaiB8IEN1cnJlbnQgJWogfCBNYXRjaDogJXMsICVzLCAlcywgJXMgfCBRdWVyeTogJXMnLFxuICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICBpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCxcbiAgICAgICAgICAgICAgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCxcbiAgICAgICAgICAgICAgaXNPcmlnaW5hbE1hdGNoZWQsXG4gICAgICAgICAgICAgIGlzQ3VycmVudE1hdGNoZWQsXG4gICAgICAgICAgICAgIHN1YnNjcmlwdGlvbi5oYXNoXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgIGxldCB0eXBlO1xuICAgICAgICAgICAgaWYgKGlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgdHlwZSA9ICd1cGRhdGUnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpc09yaWdpbmFsTWF0Y2hlZCAmJiAhaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICB0eXBlID0gJ2xlYXZlJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgaWYgKGxvY2FsT3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSAnZW50ZXInO1xuICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSAnY3JlYXRlJztcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCB3YXRjaEZpZWxkc0NoYW5nZWQgPSB0aGlzLl9jaGVja1dhdGNoRmllbGRzKGNsaWVudCwgcmVxdWVzdElkLCBtZXNzYWdlKTtcbiAgICAgICAgICAgIGlmICghd2F0Y2hGaWVsZHNDaGFuZ2VkICYmICh0eXBlID09PSAndXBkYXRlJyB8fCB0eXBlID09PSAnY3JlYXRlJykpIHtcbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gQSBgbGVhdmVgIG9yIGBlbnRlcmAgdHJhbnNpdGlvbiBjYW4gYmUgY2F1c2VkIGVpdGhlciBieSB0aGUgb2JqZWN0J3NcbiAgICAgICAgICAgIC8vIHF1ZXJ5IG1hdGNoIGNoYW5naW5nICh0aGUgc3Vic2NyaWJlciBrZWVwcyByZWFkIGFjY2Vzcykgb3IgYnkgdGhlXG4gICAgICAgICAgICAvLyBzdWJzY3JpYmVyJ3MgQUNMIHJlYWQgYWNjZXNzIGJlaW5nIHJldm9rZWQgb3IgZ3JhbnRlZCBpbiB0aGUgc2FtZSBzYXZlLlxuICAgICAgICAgICAgLy8gSW4gdGhlIGFjY2Vzcy1jaGFuZ2UgY2FzZSB0aGUgc3Vic2NyaWJlciBpcyBub3QgYXV0aG9yaXplZCB0byByZWFkIHRoZVxuICAgICAgICAgICAgLy8gb2JqZWN0IHN0YXRlIHRoYXQgdHJpZ2dlcmVkIHRoZSB0cmFuc2l0aW9uLCBzbyB0aGF0IHN0YXRlIG11c3Qgbm90IGJlXG4gICAgICAgICAgICAvLyBzZW50IG92ZXIgdGhlIGNoYW5uZWwuIChDTFAgcmVhZCBkZW5pYWwgaXMgaGFuZGxlZCBlYXJsaWVyIGJ5XG4gICAgICAgICAgICAvLyBgX21hdGNoZXNDTFBgLCB3aGljaCBza2lwcyB0aGUgZXZlbnQgZW50aXJlbHkuKVxuICAgICAgICAgICAgaWYgKHR5cGUgPT09ICdsZWF2ZScpIHtcbiAgICAgICAgICAgICAgLy8gVGhlIHBvc3QtdXBkYXRlIG9iamVjdCBpcyByZWFkYWJsZSBvbiBhIHF1ZXJ5LW1pc21hdGNoIGxlYXZlIGJ1dCBub3RcbiAgICAgICAgICAgICAgLy8gb24gYW4gQUNMLWxvc3MgbGVhdmUuIE9ubHkgc2VuZCB0aGUgcG9zdC11cGRhdGUgYm9keSB3aGVuIHRoZVxuICAgICAgICAgICAgICAvLyBzdWJzY3JpYmVyIGNhbiBzdGlsbCByZWFkIHRoZSBjdXJyZW50IG9iamVjdDsgb3RoZXJ3aXNlIGZhbGwgYmFjayB0b1xuICAgICAgICAgICAgICAvLyB0aGUgbGFzdCBhdXRob3JpemVkIChvcmlnaW5hbCkgc3RhdGUsIHdoaWNoIHN0aWxsIGNhcnJpZXMgdGhlIG9iamVjdElkLlxuICAgICAgICAgICAgICBjb25zdCBjdXJyZW50UmVhZGFibGUgPSBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkXG4gICAgICAgICAgICAgICAgPyBmYWxzZVxuICAgICAgICAgICAgICAgIDogYXdhaXQgdGhpcy5fbWF0Y2hlc0FDTChtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC5nZXRBQ0woKSwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgICBpZiAoIWN1cnJlbnRSZWFkYWJsZSkge1xuICAgICAgICAgICAgICAgIGxvY2FsQ3VycmVudFBhcnNlT2JqZWN0ID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QpKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmICh0eXBlID09PSAnZW50ZXInKSB7XG4gICAgICAgICAgICAgIC8vIFRoZSBwcmUtdXBkYXRlIG9iamVjdCB3YXMgcmVhZGFibGUgb24gYSBxdWVyeS1tYXRjaC1nYWluIGVudGVyIGJ1dCBub3RcbiAgICAgICAgICAgICAgLy8gb24gYW4gQUNMLWdyYW50IGVudGVyLiBPbmx5IHNlbmQgdGhlIHByZS11cGRhdGUgYm9keSBhcyBgb3JpZ2luYWxgXG4gICAgICAgICAgICAgIC8vIHdoZW4gdGhlIHN1YnNjcmliZXIgY291bGQgcmVhZCB0aGUgb3JpZ2luYWwgb2JqZWN0LlxuICAgICAgICAgICAgICBjb25zdCBvcmlnaW5hbFJlYWRhYmxlID0gaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWRcbiAgICAgICAgICAgICAgICA/IGZhbHNlXG4gICAgICAgICAgICAgICAgOiBhd2FpdCB0aGlzLl9tYXRjaGVzQUNMKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKSwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgICAgICBpZiAoIW9yaWdpbmFsUmVhZGFibGUpIHtcbiAgICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXMgPSB7XG4gICAgICAgICAgICAgIGV2ZW50OiB0eXBlLFxuICAgICAgICAgICAgICBzZXNzaW9uVG9rZW46IGNsaWVudC5zZXNzaW9uVG9rZW4sXG4gICAgICAgICAgICAgIG9iamVjdDogbG9jYWxDdXJyZW50UGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIG9yaWdpbmFsOiBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgICAgICAgdXNlTWFzdGVyS2V5OiBjbGllbnQuaGFzTWFzdGVyS2V5LFxuICAgICAgICAgICAgICBpbnN0YWxsYXRpb25JZDogY2xpZW50Lmluc3RhbGxhdGlvbklkLFxuICAgICAgICAgICAgICBzZW5kRXZlbnQ6IHRydWUsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgY29uc3QgdHJpZ2dlciA9IGdldFRyaWdnZXIoY2xhc3NOYW1lLCAnYWZ0ZXJFdmVudCcsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICAgICAgICAgICAgaWYgKHRyaWdnZXIpIHtcbiAgICAgICAgICAgICAgaWYgKHJlcy5vYmplY3QpIHtcbiAgICAgICAgICAgICAgICByZXMub2JqZWN0ID0gUGFyc2UuT2JqZWN0LmZyb21KU09OKHJlcy5vYmplY3QpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmIChyZXMub3JpZ2luYWwpIHtcbiAgICAgICAgICAgICAgICByZXMub3JpZ2luYWwgPSBQYXJzZS5PYmplY3QuZnJvbUpTT04ocmVzLm9yaWdpbmFsKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgdGhpcy5nZXRBdXRoRnJvbUNsaWVudChjbGllbnQsIHJlcXVlc3RJZCk7XG4gICAgICAgICAgICAgIGlmIChhdXRoICYmIGF1dGgudXNlcikge1xuICAgICAgICAgICAgICAgIHJlcy51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IHJ1blRyaWdnZXIodHJpZ2dlciwgYGFmdGVyRXZlbnQuJHtjbGFzc05hbWV9YCwgcmVzLCBhdXRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICghcmVzLnNlbmRFdmVudCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAocmVzLm9iamVjdCAmJiB0eXBlb2YgcmVzLm9iamVjdC50b0pTT04gPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgbG9jYWxDdXJyZW50UGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhyZXMub2JqZWN0LCByZXMub2JqZWN0LmNsYXNzTmFtZSB8fCBjbGFzc05hbWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHJlcy5vcmlnaW5hbCAmJiB0eXBlb2YgcmVzLm9yaWdpbmFsLnRvSlNPTiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICBsb2NhbE9yaWdpbmFsUGFyc2VPYmplY3QgPSB0b0pTT053aXRoT2JqZWN0cyhcbiAgICAgICAgICAgICAgICByZXMub3JpZ2luYWwsXG4gICAgICAgICAgICAgICAgcmVzLm9yaWdpbmFsLmNsYXNzTmFtZSB8fCBjbGFzc05hbWVcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlcy5vYmplY3QgPSBsb2NhbEN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICAgICAgICAgIHJlcy5vcmlnaW5hbCA9IGxvY2FsT3JpZ2luYWxQYXJzZU9iamVjdDtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgICAgcmVzLFxuICAgICAgICAgICAgICBjbGllbnQsXG4gICAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgIHN1YnNjcmlwdGlvbi5xdWVyeVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGNvbnN0IGZ1bmN0aW9uTmFtZSA9ICdwdXNoJyArIHJlcy5ldmVudC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHJlcy5ldmVudC5zbGljZSgxKTtcbiAgICAgICAgICAgIGlmIChjbGllbnRbZnVuY3Rpb25OYW1lXSkge1xuICAgICAgICAgICAgICBjbGllbnRbZnVuY3Rpb25OYW1lXShyZXF1ZXN0SWQsIHJlcy5vYmplY3QsIHJlcy5vcmlnaW5hbCA/PyBudWxsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IoY2xpZW50LnBhcnNlV2ViU29ja2V0LCBlcnJvci5jb2RlLCBlcnJvci5tZXNzYWdlLCBmYWxzZSwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgICAgICAgYEZhaWxlZCBydW5uaW5nIGFmdGVyTGl2ZVF1ZXJ5RXZlbnQgb24gY2xhc3MgJHtjbGFzc05hbWV9IGZvciBldmVudCAke3Jlcy5ldmVudH0gd2l0aCBzZXNzaW9uICR7cmVzLnNlc3Npb25Ub2tlbn0gd2l0aDpcXG4gRXJyb3I6IGAgK1xuICAgICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIF9vbkNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSk6IHZvaWQge1xuICAgIHBhcnNlV2Vic29ja2V0Lm9uKCdtZXNzYWdlJywgcmVxdWVzdCA9PiB7XG4gICAgICBpZiAodHlwZW9mIHJlcXVlc3QgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcmVxdWVzdCA9IEpTT04ucGFyc2UocmVxdWVzdCk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSByZXF1ZXN0JywgcmVxdWVzdCwgZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBsb2dnZXIudmVyYm9zZSgnUmVxdWVzdDogJWonLCByZXF1ZXN0KTtcblxuICAgICAgLy8gQ2hlY2sgd2hldGhlciB0aGlzIHJlcXVlc3QgaXMgYSB2YWxpZCByZXF1ZXN0LCByZXR1cm4gZXJyb3IgZGlyZWN0bHkgaWYgbm90XG4gICAgICBpZiAoXG4gICAgICAgICF0djQudmFsaWRhdGUocmVxdWVzdCwgUmVxdWVzdFNjaGVtYVsnZ2VuZXJhbCddKSB8fFxuICAgICAgICAhdHY0LnZhbGlkYXRlKHJlcXVlc3QsIFJlcXVlc3RTY2hlbWFbcmVxdWVzdC5vcF0pXG4gICAgICApIHtcbiAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMSwgdHY0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0Nvbm5lY3QgbWVzc2FnZSBlcnJvciAlcycsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2ggKHJlcXVlc3Qub3ApIHtcbiAgICAgICAgY2FzZSAnY29ubmVjdCc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlQ29ubmVjdChwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3N1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgICB0aGlzLl9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICd1bnN1YnNjcmliZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDMsICdHZXQgdW5rbm93biBvcGVyYXRpb24nKTtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ0dldCB1bmtub3duIG9wZXJhdGlvbicsIHJlcXVlc3Qub3ApO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcGFyc2VXZWJzb2NrZXQub24oJ2Rpc2Nvbm5lY3QnLCAoKSA9PiB7XG4gICAgICBsb2dnZXIuaW5mbyhgQ2xpZW50IGRpc2Nvbm5lY3Q6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgICBjb25zdCBjbGllbnRJZCA9IHBhcnNlV2Vic29ja2V0LmNsaWVudElkO1xuICAgICAgaWYgKCF0aGlzLmNsaWVudHMuaGFzKGNsaWVudElkKSkge1xuICAgICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3RfZXJyb3InLFxuICAgICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgICAgICAgIGVycm9yOiBgVW5hYmxlIHRvIGZpbmQgY2xpZW50ICR7Y2xpZW50SWR9YCxcbiAgICAgICAgfSk7XG4gICAgICAgIGxvZ2dlci5lcnJvcihgQ2FuIG5vdCBmaW5kIGNsaWVudCAke2NsaWVudElkfSBvbiBkaXNjb25uZWN0YCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gRGVsZXRlIGNsaWVudFxuICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICB0aGlzLmNsaWVudHMuZGVsZXRlKGNsaWVudElkKTtcblxuICAgICAgLy8gRGVsZXRlIGNsaWVudCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICAgIGZvciAoY29uc3QgW3JlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mb10gb2YgXy5lbnRyaWVzKGNsaWVudC5zdWJzY3JpcHRpb25JbmZvcykpIHtcbiAgICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgICAgIHN1YnNjcmlwdGlvbi5kZWxldGVDbGllbnRTdWJzY3JpcHRpb24oY2xpZW50SWQsIHJlcXVlc3RJZCk7XG5cbiAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xpZW50IHdoaWNoIGlzIHN1YnNjcmliaW5nIHRoaXMgc3Vic2NyaXB0aW9uLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoc3Vic2NyaXB0aW9uLmNsYXNzTmFtZSk7XG4gICAgICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMpIHtcbiAgICAgICAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5oYXNoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnRzICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgc3Vic2NyaXB0aW9ucyAlZCcsIHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplKTtcbiAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICBldmVudDogJ3dzX2Rpc2Nvbm5lY3QnLFxuICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IGNsaWVudC5pbnN0YWxsYXRpb25JZCxcbiAgICAgICAgc2Vzc2lvblRva2VuOiBjbGllbnQuc2Vzc2lvblRva2VuLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnd3NfY29ubmVjdCcsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplLFxuICAgIH0pO1xuICB9XG5cbiAgX3ZhbGlkYXRlUXVlcnlDb25zdHJhaW50cyh3aGVyZTogYW55KTogdm9pZCB7XG4gICAgaWYgKHR5cGVvZiB3aGVyZSAhPT0gJ29iamVjdCcgfHwgd2hlcmUgPT09IG51bGwpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBvcCBvZiBbJyRvcicsICckYW5kJywgJyRub3InXSkge1xuICAgICAgaWYgKHdoZXJlW29wXSAhPT0gdW5kZWZpbmVkICYmICFBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIGAke29wfSBtdXN0IGJlIGFuIGFycmF5YCk7XG4gICAgICB9XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheSh3aGVyZVtvcF0pKSB7XG4gICAgICAgIHdoZXJlW29wXS5mb3JFYWNoKChzdWJRdWVyeTogYW55KSA9PiB7XG4gICAgICAgICAgdGhpcy5fdmFsaWRhdGVRdWVyeUNvbnN0cmFpbnRzKHN1YlF1ZXJ5KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHdoZXJlKSkge1xuICAgICAgY29uc3QgY29uc3RyYWludCA9IHdoZXJlW2tleV07XG4gICAgICBpZiAodHlwZW9mIGNvbnN0cmFpbnQgPT09ICdvYmplY3QnICYmIGNvbnN0cmFpbnQgIT09IG51bGwpIHtcbiAgICAgICAgaWYgKGNvbnN0cmFpbnQuJHJlZ2V4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCByZWdleCA9IGNvbnN0cmFpbnQuJHJlZ2V4O1xuICAgICAgICAgIGNvbnN0IGlzUmVnRXhwTGlrZSA9XG4gICAgICAgICAgICByZWdleCAhPT0gbnVsbCAmJlxuICAgICAgICAgICAgdHlwZW9mIHJlZ2V4ID09PSAnb2JqZWN0JyAmJlxuICAgICAgICAgICAgdHlwZW9mIHJlZ2V4LnNvdXJjZSA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgICAgIHR5cGVvZiByZWdleC5mbGFncyA9PT0gJ3N0cmluZyc7XG4gICAgICAgICAgaWYgKHR5cGVvZiByZWdleCAhPT0gJ3N0cmluZycgJiYgIWlzUmVnRXhwTGlrZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICAnSW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb246ICRyZWdleCBtdXN0IGJlIGEgc3RyaW5nIG9yIFJlZ0V4cCdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGNvbnN0IHBhdHRlcm4gPSBpc1JlZ0V4cExpa2UgPyByZWdleC5zb3VyY2UgOiByZWdleDtcbiAgICAgICAgICBjb25zdCBmbGFncyA9IGlzUmVnRXhwTGlrZSA/IHJlZ2V4LmZsYWdzIDogY29uc3RyYWludC4kb3B0aW9ucyB8fCAnJztcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgbmV3IFJlZ0V4cChwYXR0ZXJuLCBmbGFncyk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAgICAgICBgSW52YWxpZCByZWd1bGFyIGV4cHJlc3Npb246ICR7ZS5tZXNzYWdlfWBcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgX21hdGNoZXNTdWJzY3JpcHRpb24ocGFyc2VPYmplY3Q6IGFueSwgc3Vic2NyaXB0aW9uOiBhbnkpOiBib29sZWFuIHtcbiAgICAvLyBPYmplY3QgaXMgdW5kZWZpbmVkIG9yIG51bGwsIG5vdCBtYXRjaFxuICAgIGlmICghcGFyc2VPYmplY3QpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgcmV0dXJuIG1hdGNoZXNRdWVyeShzdHJ1Y3R1cmVkQ2xvbmUocGFyc2VPYmplY3QpLCBzdWJzY3JpcHRpb24ucXVlcnkpO1xuICB9XG5cbiAgYXN5bmMgX2NsZWFyQ2FjaGVkUm9sZXModXNlcklkOiBzdHJpbmcpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsaWRUb2tlbnMgPSBhd2FpdCBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuU2Vzc2lvbilcbiAgICAgICAgLmVxdWFsVG8oJ3VzZXInLCBQYXJzZS5Vc2VyLmNyZWF0ZVdpdGhvdXREYXRhKHVzZXJJZCkpXG4gICAgICAgIC5maW5kKHsgdXNlTWFzdGVyS2V5OiB0cnVlIH0pO1xuICAgICAgYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgICAgIHZhbGlkVG9rZW5zLm1hcChhc3luYyB0b2tlbiA9PiB7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvblRva2VuID0gdG9rZW4uZ2V0KCdzZXNzaW9uVG9rZW4nKTtcbiAgICAgICAgICBjb25zdCBhdXRoUHJvbWlzZSA9IHRoaXMuYXV0aENhY2hlLmdldChzZXNzaW9uVG9rZW4pO1xuICAgICAgICAgIGlmICghYXV0aFByb21pc2UpIHtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgW2F1dGgxLCBhdXRoMl0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgICAgICBhdXRoUHJvbWlzZSxcbiAgICAgICAgICAgIGdldEF1dGhGb3JTZXNzaW9uVG9rZW4oeyBjYWNoZUNvbnRyb2xsZXI6IHRoaXMuY2FjaGVDb250cm9sbGVyLCBzZXNzaW9uVG9rZW4gfSksXG4gICAgICAgICAgXSk7XG4gICAgICAgICAgYXV0aDEuYXV0aD8uY2xlYXJSb2xlQ2FjaGUoc2Vzc2lvblRva2VuKTtcbiAgICAgICAgICBhdXRoMi5hdXRoPy5jbGVhclJvbGVDYWNoZShzZXNzaW9uVG9rZW4pO1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLmRlbGV0ZShzZXNzaW9uVG9rZW4pO1xuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIudmVyYm9zZShgQ291bGQgbm90IGNsZWFyIHJvbGUgY2FjaGUuICR7ZX1gKTtcbiAgICB9XG4gIH1cblxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuKHNlc3Npb25Ub2tlbj86IHN0cmluZyk6IFByb21pc2U8eyBhdXRoPzogQXV0aCwgdXNlcklkPzogc3RyaW5nIH0+IHtcbiAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gICAgfVxuICAgIGNvbnN0IGZyb21DYWNoZSA9IHRoaXMuYXV0aENhY2hlLmdldChzZXNzaW9uVG9rZW4pO1xuICAgIGlmIChmcm9tQ2FjaGUpIHtcbiAgICAgIHJldHVybiBmcm9tQ2FjaGU7XG4gICAgfVxuICAgIGNvbnN0IGF1dGhQcm9taXNlID0gZ2V0QXV0aEZvclNlc3Npb25Ub2tlbih7XG4gICAgICBjYWNoZUNvbnRyb2xsZXI6IHRoaXMuY2FjaGVDb250cm9sbGVyLFxuICAgICAgc2Vzc2lvblRva2VuOiBzZXNzaW9uVG9rZW4sXG4gICAgfSlcbiAgICAgIC50aGVuKGF1dGggPT4ge1xuICAgICAgICByZXR1cm4geyBhdXRoLCB1c2VySWQ6IGF1dGggJiYgYXV0aC51c2VyICYmIGF1dGgudXNlci5pZCB9O1xuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFRoZXJlIHdhcyBhbiBlcnJvciB3aXRoIHRoZSBzZXNzaW9uIHRva2VuXG4gICAgICAgIGNvbnN0IHJlc3VsdDogYW55ID0ge307XG4gICAgICAgIGlmIChlcnJvciAmJiBlcnJvci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX1NFU1NJT05fVE9LRU4pIHtcbiAgICAgICAgICByZXN1bHQuZXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICB0aGlzLmF1dGhDYWNoZS5zZXQoc2Vzc2lvblRva2VuLCBQcm9taXNlLnJlc29sdmUocmVzdWx0KSwgdGhpcy5jb25maWcuY2FjaGVUaW1lb3V0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmF1dGhDYWNoZS5kZWxldGUoc2Vzc2lvblRva2VuKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgfSk7XG4gICAgdGhpcy5hdXRoQ2FjaGUuc2V0KHNlc3Npb25Ub2tlbiwgYXV0aFByb21pc2UpO1xuICAgIHJldHVybiBhdXRoUHJvbWlzZTtcbiAgfVxuXG4gIGFzeW5jIF9tYXRjaGVzQ0xQKFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucz86IGFueSxcbiAgICBvYmplY3Q/OiBhbnksXG4gICAgY2xpZW50PzogYW55LFxuICAgIHJlcXVlc3RJZD86IG51bWJlcixcbiAgICBvcD86IHN0cmluZ1xuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGNvbnN0IGFjbEdyb3VwID0gWycqJ107XG4gICAgbGV0IHVzZXJJZDtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4pO1xuICAgICAgdXNlcklkID0gcmVzdWx0LnVzZXJJZDtcbiAgICAgIGlmICh1c2VySWQpIHtcbiAgICAgICAgYWNsR3JvdXAucHVzaCh1c2VySWQpO1xuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgIG9iamVjdC5jbGFzc05hbWUsXG4gICAgICBhY2xHcm91cCxcbiAgICAgIG9wXG4gICAgKTtcbiAgICAvLyBFbmZvcmNlIHBvaW50ZXIgcGVybWlzc2lvbnMgdGhhdCB2YWxpZGF0ZVBlcm1pc3Npb24gZGVmZXJzLlxuICAgIC8vIFJldHVybnMgZmFsc2UgdG8gc2lsZW50bHkgc2tpcCB0aGUgZXZlbnQgKGxpa2UgQUNMKSwgcmF0aGVyIHRoYW5cbiAgICAvLyB0aHJvd2luZyB3aGljaCB3b3VsZCBwdXNoIGVycm9ycyB0byB0aGUgY2xpZW50IGFuZCBsb2cgbm9pc2UuXG4gICAgaWYgKCFjbGllbnQuaGFzTWFzdGVyS2V5ICYmIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucykge1xuICAgICAgY29uc3QgcGVybWlzc2lvbkZpZWxkID1cbiAgICAgICAgWydnZXQnLCAnZmluZCcsICdjb3VudCddLmluZGV4T2Yob3ApID4gLTEgPyAncmVhZFVzZXJGaWVsZHMnIDogJ3dyaXRlVXNlckZpZWxkcyc7XG4gICAgICBjb25zdCBwb2ludGVyRmllbGRzID0gW107XG4gICAgICBpZiAoY2xhc3NMZXZlbFBlcm1pc3Npb25zW29wXT8ucG9pbnRlckZpZWxkcykge1xuICAgICAgICBwb2ludGVyRmllbGRzLnB1c2goLi4uY2xhc3NMZXZlbFBlcm1pc3Npb25zW29wXS5wb2ludGVyRmllbGRzKTtcbiAgICAgIH1cbiAgICAgIGlmIChBcnJheS5pc0FycmF5KGNsYXNzTGV2ZWxQZXJtaXNzaW9uc1twZXJtaXNzaW9uRmllbGRdKSkge1xuICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGNsYXNzTGV2ZWxQZXJtaXNzaW9uc1twZXJtaXNzaW9uRmllbGRdKSB7XG4gICAgICAgICAgaWYgKCFwb2ludGVyRmllbGRzLmluY2x1ZGVzKGZpZWxkKSkge1xuICAgICAgICAgICAgcG9pbnRlckZpZWxkcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChwb2ludGVyRmllbGRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gSWYgcHVibGljIG9yIHVzZXItc3BlY2lmaWMgcGVybWlzc2lvbiBhbHJlYWR5IGdyYW50cyBhY2Nlc3MsIHNraXAgcG9pbnRlciBjaGVja1xuICAgICAgICBpZiAoXG4gICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIudGVzdFBlcm1pc3Npb25zKGNsYXNzTGV2ZWxQZXJtaXNzaW9ucywgYWNsR3JvdXAsIG9wKVxuICAgICAgICApIHtcbiAgICAgICAgICBpZiAoIXVzZXJJZCkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBDaGVjayBpZiBhbnkgcG9pbnRlciBmaWVsZCBwb2ludHMgdG8gdGhlIGN1cnJlbnQgdXNlclxuICAgICAgICAgIGNvbnN0IGhhc0FjY2VzcyA9IHBvaW50ZXJGaWVsZHMuc29tZShmaWVsZCA9PiB7XG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9XG4gICAgICAgICAgICAgIHR5cGVvZiBvYmplY3QuZ2V0ID09PSAnZnVuY3Rpb24nID8gb2JqZWN0LmdldChmaWVsZCkgOiBvYmplY3RbZmllbGRdO1xuICAgICAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBIYW5kbGUgUGFyc2UuT2JqZWN0IHBvaW50ZXIgKGhhcyAuaWQpXG4gICAgICAgICAgICBpZiAodmFsdWUuaWQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLmlkID09PSB1c2VySWQ7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvLyBIYW5kbGUgcmF3IHBvaW50ZXIgSlNPTiAoaGFzIC5vYmplY3RJZClcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vYmplY3RJZCkge1xuICAgICAgICAgICAgICByZXR1cm4gdmFsdWUub2JqZWN0SWQgPT09IHVzZXJJZDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIEhhbmRsZSBhcnJheSBvZiBwb2ludGVyc1xuICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgIHJldHVybiB2YWx1ZS5zb21lKGl0ZW0gPT4ge1xuICAgICAgICAgICAgICAgIGlmIChpdGVtLmlkKSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gaXRlbS5pZCA9PT0gdXNlcklkO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaXRlbS5vYmplY3RJZCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIGl0ZW0ub2JqZWN0SWQgPT09IHVzZXJJZDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAoIWhhc0FjY2Vzcykge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGFzeW5jIF9maWx0ZXJTZW5zaXRpdmVEYXRhKFxuICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucz86IGFueSxcbiAgICByZXM/OiBhbnksXG4gICAgY2xpZW50PzogYW55LFxuICAgIHJlcXVlc3RJZD86IG51bWJlcixcbiAgICBvcD86IHN0cmluZyxcbiAgICBxdWVyeT86IGFueVxuICApIHtcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBjb25zdCBhY2xHcm91cCA9IFsnKiddO1xuICAgIGxldCBjbGllbnRBdXRoO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGNvbnN0IHsgdXNlcklkLCBhdXRoIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4pO1xuICAgICAgaWYgKHVzZXJJZCkge1xuICAgICAgICBhY2xHcm91cC5wdXNoKHVzZXJJZCk7XG4gICAgICB9XG4gICAgICBjbGllbnRBdXRoID0gYXV0aDtcbiAgICB9XG4gICAgY29uc3QgZmlsdGVyID0gb2JqID0+IHtcbiAgICAgIGlmICghb2JqKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGxldCBwcm90ZWN0ZWRGaWVsZHMgPSBjbGFzc0xldmVsUGVybWlzc2lvbnM/LnByb3RlY3RlZEZpZWxkcyB8fCBbXTtcbiAgICAgIGlmIChjbGllbnQuaGFzTWFzdGVyS2V5KSB7XG4gICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IFtdO1xuICAgICAgfSBlbHNlIGlmICghQXJyYXkuaXNBcnJheShwcm90ZWN0ZWRGaWVsZHMpKSB7XG4gICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IGdldERhdGFiYXNlQ29udHJvbGxlcih0aGlzLmNvbmZpZykuYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICByZXMub2JqZWN0LmNsYXNzTmFtZSxcbiAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgICBjbGllbnRBdXRoXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gRGF0YWJhc2VDb250cm9sbGVyLmZpbHRlclNlbnNpdGl2ZURhdGEoXG4gICAgICAgIGNsaWVudC5oYXNNYXN0ZXJLZXksXG4gICAgICAgIGZhbHNlLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgY2xpZW50QXV0aCxcbiAgICAgICAgb3AsXG4gICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgcmVzLm9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIHByb3RlY3RlZEZpZWxkcyxcbiAgICAgICAgb2JqLFxuICAgICAgICB0aGlzLmNvbmZpZy5wcm90ZWN0ZWRGaWVsZHNPd25lckV4ZW1wdFxuICAgICAgKTtcbiAgICB9O1xuICAgIHJlcy5vYmplY3QgPSBmaWx0ZXIocmVzLm9iamVjdCk7XG4gICAgcmVzLm9yaWdpbmFsID0gZmlsdGVyKHJlcy5vcmlnaW5hbCk7XG4gIH1cblxuICBfZ2V0Q0xQT3BlcmF0aW9uKHF1ZXJ5OiBhbnkpIHtcbiAgICByZXR1cm4gdHlwZW9mIHF1ZXJ5ID09PSAnb2JqZWN0JyAmJlxuICAgICAgT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PSAxICYmXG4gICAgICB0eXBlb2YgcXVlcnkub2JqZWN0SWQgPT09ICdzdHJpbmcnXG4gICAgICA/ICdnZXQnXG4gICAgICA6ICdmaW5kJztcbiAgfVxuXG4gIGFzeW5jIF92ZXJpZnlBQ0woYWNsOiBhbnksIHRva2VuOiBzdHJpbmcpIHtcbiAgICBpZiAoIXRva2VuKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgY29uc3QgeyBhdXRoLCB1c2VySWQgfSA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZvclNlc3Npb25Ub2tlbih0b2tlbik7XG5cbiAgICAvLyBHZXR0aW5nIHRoZSBzZXNzaW9uIHRva2VuIGZhaWxlZFxuICAgIC8vIFRoaXMgbWVhbnMgdGhhdCBubyBhZGRpdGlvbmFsIGF1dGggaXMgYXZhaWxhYmxlXG4gICAgLy8gQXQgdGhpcyBwb2ludCwganVzdCBiYWlsIG91dCBhcyBubyBhZGRpdGlvbmFsIHZpc2liaWxpdHkgY2FuIGJlIGluZmVycmVkLlxuICAgIGlmICghYXV0aCB8fCAhdXNlcklkKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGNvbnN0IGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCA9IGFjbC5nZXRSZWFkQWNjZXNzKHVzZXJJZCk7XG4gICAgaWYgKGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgaWYgdGhlIHVzZXIgaGFzIGFueSByb2xlcyB0aGF0IG1hdGNoIHRoZSBBQ0xcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgIC50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgLy8gUmVzb2x2ZSBmYWxzZSByaWdodCBhd2F5IGlmIHRoZSBhY2wgZG9lc24ndCBoYXZlIGFueSByb2xlc1xuICAgICAgICBjb25zdCBhY2xfaGFzX3JvbGVzID0gT2JqZWN0LmtleXMoYWNsLnBlcm1pc3Npb25zQnlJZCkuc29tZShrZXkgPT4ga2V5LnN0YXJ0c1dpdGgoJ3JvbGU6JykpO1xuICAgICAgICBpZiAoIWFjbF9oYXNfcm9sZXMpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm9sZU5hbWVzID0gYXdhaXQgYXV0aC5nZXRVc2VyUm9sZXMoKTtcbiAgICAgICAgLy8gRmluYWxseSwgc2VlIGlmIGFueSBvZiB0aGUgdXNlcidzIHJvbGVzIGFsbG93IHRoZW0gcmVhZCBhY2Nlc3NcbiAgICAgICAgZm9yIChjb25zdCByb2xlIG9mIHJvbGVOYW1lcykge1xuICAgICAgICAgIC8vIFdlIHVzZSBnZXRSZWFkQWNjZXNzIGFzIGByb2xlYCBpcyBpbiB0aGUgZm9ybSBgcm9sZTpyb2xlTmFtZWBcbiAgICAgICAgICBpZiAoYWNsLmdldFJlYWRBY2Nlc3Mocm9sZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBnZXRBdXRoRnJvbUNsaWVudChjbGllbnQ6IGFueSwgcmVxdWVzdElkOiBudW1iZXIsIHNlc3Npb25Ub2tlbj86IHN0cmluZykge1xuICAgIGNvbnN0IGdldFNlc3Npb25Gcm9tQ2xpZW50ID0gKCkgPT4ge1xuICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgIHJldHVybiBjbGllbnQuc2Vzc2lvblRva2VuO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuIHx8IGNsaWVudC5zZXNzaW9uVG9rZW47XG4gICAgfTtcbiAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgc2Vzc2lvblRva2VuID0gZ2V0U2Vzc2lvbkZyb21DbGllbnQoKTtcbiAgICB9XG4gICAgaWYgKCFzZXNzaW9uVG9rZW4pIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgeyBhdXRoIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oc2Vzc2lvblRva2VuKTtcbiAgICByZXR1cm4gYXV0aDtcbiAgfVxuXG4gIF9jaGVja1dhdGNoRmllbGRzKGNsaWVudDogYW55LCByZXF1ZXN0SWQ6IGFueSwgbWVzc2FnZTogYW55KSB7XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgY29uc3Qgd2F0Y2ggPSBzdWJzY3JpcHRpb25JbmZvPy53YXRjaDtcbiAgICBpZiAoIXdhdGNoKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgY29uc3Qgb2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgY29uc3Qgb3JpZ2luYWwgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3Q7XG4gICAgcmV0dXJuIHdhdGNoLnNvbWUoZmllbGQgPT4gIWlzRGVlcFN0cmljdEVxdWFsKG9iamVjdC5nZXQoZmllbGQpLCBvcmlnaW5hbD8uZ2V0KGZpZWxkKSkpO1xuICB9XG5cbiAgYXN5bmMgX21hdGNoZXNBQ0woYWNsOiBhbnksIGNsaWVudDogYW55LCByZXF1ZXN0SWQ6IG51bWJlcik6IFByb21pc2U8Ym9vbGVhbj4ge1xuICAgIC8vIFJldHVybiB0cnVlIGRpcmVjdGx5IGlmIEFDTCBpc24ndCBwcmVzZW50LCBBQ0wgaXMgcHVibGljIHJlYWQsIG9yIGNsaWVudCBoYXMgbWFzdGVyIGtleVxuICAgIGlmICghYWNsIHx8IGFjbC5nZXRQdWJsaWNSZWFkQWNjZXNzKCkgfHwgY2xpZW50Lmhhc01hc3RlcktleSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIC8vIENoZWNrIHN1YnNjcmlwdGlvbiBzZXNzaW9uVG9rZW4gbWF0Y2hlcyBBQ0wgZmlyc3RcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uVG9rZW4gPSBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbjtcbiAgICBjb25zdCBjbGllbnRTZXNzaW9uVG9rZW4gPSBjbGllbnQuc2Vzc2lvblRva2VuO1xuXG4gICAgaWYgKGF3YWl0IHRoaXMuX3ZlcmlmeUFDTChhY2wsIHN1YnNjcmlwdGlvblRva2VuKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgaWYgKGF3YWl0IHRoaXMuX3ZlcmlmeUFDTChhY2wsIGNsaWVudFNlc3Npb25Ub2tlbikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGFzeW5jIF9oYW5kbGVDb25uZWN0KHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IFByb21pc2U8YW55PiB7XG4gICAgaWYgKCF0aGlzLl92YWxpZGF0ZUtleXMocmVxdWVzdCwgdGhpcy5rZXlQYWlycykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDQsICdLZXkgaW4gcmVxdWVzdCBpcyBub3QgdmFsaWQnKTtcbiAgICAgIGxvZ2dlci5lcnJvcignS2V5IGluIHJlcXVlc3QgaXMgbm90IHZhbGlkJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGhhc01hc3RlcktleSA9IHRoaXMuX2hhc01hc3RlcktleShyZXF1ZXN0LCB0aGlzLmtleVBhaXJzKTtcbiAgICBjb25zdCBjbGllbnRJZCA9IHJhbmRvbVVVSUQoKTtcbiAgICBjb25zdCBjbGllbnQgPSBuZXcgQ2xpZW50KFxuICAgICAgY2xpZW50SWQsXG4gICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgIGhhc01hc3RlcktleSxcbiAgICAgIHJlcXVlc3Quc2Vzc2lvblRva2VuLFxuICAgICAgcmVxdWVzdC5pbnN0YWxsYXRpb25JZFxuICAgICk7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcSA9IHtcbiAgICAgICAgY2xpZW50LFxuICAgICAgICBldmVudDogJ2Nvbm5lY3QnLFxuICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgIHNlc3Npb25Ub2tlbjogcmVxdWVzdC5zZXNzaW9uVG9rZW4sXG4gICAgICAgIHVzZU1hc3RlcktleTogY2xpZW50Lmhhc01hc3RlcktleSxcbiAgICAgICAgaW5zdGFsbGF0aW9uSWQ6IHJlcXVlc3QuaW5zdGFsbGF0aW9uSWQsXG4gICAgICAgIHVzZXI6IHVuZGVmaW5lZCxcbiAgICAgIH07XG4gICAgICBjb25zdCB0cmlnZ2VyID0gZ2V0VHJpZ2dlcignQENvbm5lY3QnLCAnYmVmb3JlQ29ubmVjdCcsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICAgICAgaWYgKHRyaWdnZXIpIHtcbiAgICAgICAgY29uc3QgYXV0aCA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZyb21DbGllbnQoY2xpZW50LCByZXF1ZXN0LnJlcXVlc3RJZCwgcmVxLnNlc3Npb25Ub2tlbik7XG4gICAgICAgIGlmIChhdXRoICYmIGF1dGgudXNlcikge1xuICAgICAgICAgIHJlcS51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHJ1blRyaWdnZXIodHJpZ2dlciwgYGJlZm9yZUNvbm5lY3QuQENvbm5lY3RgLCByZXEsIGF1dGgpO1xuICAgICAgfVxuICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgPSBjbGllbnRJZDtcbiAgICAgIHRoaXMuY2xpZW50cy5zZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIGNsaWVudCk7XG4gICAgICBsb2dnZXIuaW5mbyhgQ3JlYXRlIG5ldyBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgICBjbGllbnQucHVzaENvbm5lY3QoKTtcbiAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMocmVxKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBlcnJvciA9IHJlc29sdmVFcnJvcihlKTtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIGVycm9yLmNvZGUsIGVycm9yLm1lc3NhZ2UsIGZhbHNlKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgYEZhaWxlZCBydW5uaW5nIGJlZm9yZUNvbm5lY3QgZm9yIHNlc3Npb24gJHtyZXF1ZXN0LnNlc3Npb25Ub2tlbn0gd2l0aDpcXG4gRXJyb3I6IGAgK1xuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGVycm9yKVxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBfaGFzTWFzdGVyS2V5KHJlcXVlc3Q6IGFueSwgdmFsaWRLZXlQYWlyczogYW55KTogYm9vbGVhbiB7XG4gICAgaWYgKCF2YWxpZEtleVBhaXJzIHx8IHZhbGlkS2V5UGFpcnMuc2l6ZSA9PSAwIHx8ICF2YWxpZEtleVBhaXJzLmhhcygnbWFzdGVyS2V5JykpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKCFyZXF1ZXN0IHx8ICFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVxdWVzdCwgJ21hc3RlcktleScpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiByZXF1ZXN0Lm1hc3RlcktleSA9PT0gdmFsaWRLZXlQYWlycy5nZXQoJ21hc3RlcktleScpO1xuICB9XG5cbiAgX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0OiBhbnksIHZhbGlkS2V5UGFpcnM6IGFueSk6IGJvb2xlYW4ge1xuICAgIGlmICghdmFsaWRLZXlQYWlycyB8fCB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGxldCBpc1ZhbGlkID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBba2V5LCBzZWNyZXRdIG9mIHZhbGlkS2V5UGFpcnMpIHtcbiAgICAgIGlmICghcmVxdWVzdFtrZXldIHx8IHJlcXVlc3Rba2V5XSAhPT0gc2VjcmV0KSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaXNWYWxpZCA9IHRydWU7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgcmV0dXJuIGlzVmFsaWQ7XG4gIH1cblxuICBhc3luYyBfaGFuZGxlU3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IFByb21pc2U8YW55PiB7XG4gICAgLy8gSWYgd2UgY2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCByZXR1cm4gZXJyb3IgdG8gY2xpZW50XG4gICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocGFyc2VXZWJzb2NrZXQsICdjbGllbnRJZCcpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKCdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHJlcXVlc3QucXVlcnkuY2xhc3NOYW1lO1xuICAgIGxldCBhdXRoQ2FsbGVkID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHRyaWdnZXIgPSBnZXRUcmlnZ2VyKGNsYXNzTmFtZSwgJ2JlZm9yZVN1YnNjcmliZScsIFBhcnNlLmFwcGxpY2F0aW9uSWQpO1xuICAgICAgaWYgKHRyaWdnZXIpIHtcbiAgICAgICAgY29uc3QgYXV0aCA9IGF3YWl0IHRoaXMuZ2V0QXV0aEZyb21DbGllbnQoY2xpZW50LCByZXF1ZXN0LnJlcXVlc3RJZCwgcmVxdWVzdC5zZXNzaW9uVG9rZW4pO1xuICAgICAgICBhdXRoQ2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgcmVxdWVzdC51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGFyc2VRdWVyeSA9IG5ldyBQYXJzZS5RdWVyeShjbGFzc05hbWUpO1xuICAgICAgICBwYXJzZVF1ZXJ5LndpdGhKU09OKHJlcXVlc3QucXVlcnkpO1xuICAgICAgICByZXF1ZXN0LnF1ZXJ5ID0gcGFyc2VRdWVyeTtcbiAgICAgICAgYXdhaXQgcnVuVHJpZ2dlcih0cmlnZ2VyLCBgYmVmb3JlU3Vic2NyaWJlLiR7Y2xhc3NOYW1lfWAsIHJlcXVlc3QsIGF1dGgpO1xuXG4gICAgICAgIGNvbnN0IHF1ZXJ5ID0gcmVxdWVzdC5xdWVyeS50b0pTT04oKTtcbiAgICAgICAgcmVxdWVzdC5xdWVyeSA9IHF1ZXJ5O1xuICAgICAgfVxuXG4gICAgICBpZiAoY2xhc3NOYW1lID09PSAnX1Nlc3Npb24nKSB7XG4gICAgICAgIGlmICghYXV0aENhbGxlZCkge1xuICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWQsXG4gICAgICAgICAgICByZXF1ZXN0LnNlc3Npb25Ub2tlblxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgICByZXF1ZXN0LnVzZXIgPSBhdXRoLnVzZXI7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChyZXF1ZXN0LnVzZXIpIHtcbiAgICAgICAgICByZXF1ZXN0LnF1ZXJ5LndoZXJlLnVzZXIgPSByZXF1ZXN0LnVzZXIudG9Qb2ludGVyKCk7XG4gICAgICAgIH0gZWxzZSBpZiAoIXJlcXVlc3QubWFzdGVyKSB7XG4gICAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9TRVNTSU9OX1RPS0VOLFxuICAgICAgICAgICAgJ0ludmFsaWQgc2Vzc2lvbiB0b2tlbicsXG4gICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgIHJlcXVlc3QucmVxdWVzdElkXG4gICAgICAgICAgKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIC8vIFZhbGlkYXRlIHF1ZXJ5IGNvbmRpdGlvbiBkZXB0aFxuICAgICAgY29uc3QgYXBwQ29uZmlnID0gQ29uZmlnLmdldCh0aGlzLmNvbmZpZy5hcHBJZCk7XG4gICAgICBpZiAoIWNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgICAgY29uc3QgcmMgPSBhcHBDb25maWcucmVxdWVzdENvbXBsZXhpdHk7XG4gICAgICAgIGlmIChyYyAmJiByYy5xdWVyeURlcHRoICE9PSAtMSkge1xuICAgICAgICAgIGNvbnN0IG1heERlcHRoID0gcmMucXVlcnlEZXB0aDtcbiAgICAgICAgICBjb25zdCBjaGVja0RlcHRoID0gKG5vZGU6IGFueSwgZGVwdGg6IG51bWJlcikgPT4ge1xuICAgICAgICAgICAgaWYgKGRlcHRoID4gbWF4RGVwdGgpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICAgICAgYFF1ZXJ5IGNvbmRpdGlvbiBuZXN0aW5nIGRlcHRoIGV4Y2VlZHMgbWF4aW11bSBhbGxvd2VkIGRlcHRoIG9mICR7bWF4RGVwdGh9YFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKG5vZGUgPT09IG51bGwgfHwgdHlwZW9mIG5vZGUgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KG5vZGUpKSB7XG4gICAgICAgICAgICAgIGZvciAoY29uc3QgaXRlbSBvZiBub2RlKSB7XG4gICAgICAgICAgICAgICAgY2hlY2tEZXB0aChpdGVtLCBkZXB0aCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gRGVzY2VuZCBpbnRvIGV2ZXJ5IHZhbHVlIHNvIHRoYXQgbG9naWNhbCBvcGVyYXRvcnMgKCRvci8kYW5kLyRub3IpXG4gICAgICAgICAgICAvLyBuZXN0ZWQgdW5kZXIgZmllbGQtbGV2ZWwgb3BlcmF0b3JzIChlLmcuICRlbGVtTWF0Y2gsICRub3QpIG9yIHBsYWluXG4gICAgICAgICAgICAvLyBmaWVsZCBuYW1lcyBhcmUgc3RpbGwgY291bnRlZC4gT25seSBsb2dpY2FsIG9wZXJhdG9ycyBpbmNyZWFzZSB0aGVcbiAgICAgICAgICAgIC8vIGRlcHRoLCB3aGljaCBwcmVzZXJ2ZXMgdGhlIGRvY3VtZW50ZWQgbWVhbmluZyBvZiBgcXVlcnlEZXB0aGAuXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgICAgICAgICAgICBjb25zdCBpc0xvZ2ljYWwgPSBrZXkgPT09ICckb3InIHx8IGtleSA9PT0gJyRhbmQnIHx8IGtleSA9PT0gJyRub3InO1xuICAgICAgICAgICAgICBpZiAoaXNMb2dpY2FsICYmICFBcnJheS5pc0FycmF5KG5vZGVba2V5XSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYCR7a2V5fSBtdXN0IGJlIGFuIGFycmF5YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgY2hlY2tEZXB0aChub2RlW2tleV0sIGlzTG9naWNhbCA/IGRlcHRoICsgMSA6IGRlcHRoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9O1xuICAgICAgICAgIGNoZWNrRGVwdGgocmVxdWVzdC5xdWVyeS53aGVyZSwgMCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgYWxsb3dSZWdleFxuICAgICAgaWYgKCFjbGllbnQuaGFzTWFzdGVyS2V5KSB7XG4gICAgICAgIGNvbnN0IHJjID0gYXBwQ29uZmlnLnJlcXVlc3RDb21wbGV4aXR5O1xuICAgICAgICBpZiAocmMgJiYgcmMuYWxsb3dSZWdleCA9PT0gZmFsc2UpIHtcbiAgICAgICAgICBjb25zdCBjaGVja1JlZ2V4ID0gKHdoZXJlOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygd2hlcmUgIT09ICdvYmplY3QnIHx8IHdoZXJlID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHdoZXJlKSkge1xuICAgICAgICAgICAgICBjb25zdCBjb25zdHJhaW50ID0gd2hlcmVba2V5XTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBjb25zdHJhaW50ID09PSAnb2JqZWN0JyAmJiBjb25zdHJhaW50ICE9PSBudWxsICYmIGNvbnN0cmFpbnQuJHJlZ2V4ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJyRyZWdleCBvcGVyYXRvciBpcyBub3QgYWxsb3dlZCcpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmb3IgKGNvbnN0IG9wIG9mIFsnJG9yJywgJyRhbmQnLCAnJG5vciddKSB7XG4gICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHdoZXJlW29wXSkpIHtcbiAgICAgICAgICAgICAgICBmb3IgKGNvbnN0IHN1YlF1ZXJ5IG9mIHdoZXJlW29wXSkge1xuICAgICAgICAgICAgICAgICAgY2hlY2tSZWdleChzdWJRdWVyeSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfTtcbiAgICAgICAgICBjaGVja1JlZ2V4KHJlcXVlc3QucXVlcnkud2hlcmUpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIENMUCBmb3Igc3Vic2NyaWJlIG9wZXJhdGlvblxuICAgICAgY29uc3Qgc2NoZW1hQ29udHJvbGxlciA9IGF3YWl0IGFwcENvbmZpZy5kYXRhYmFzZS5sb2FkU2NoZW1hKCk7XG4gICAgICBjb25zdCBjbGFzc0xldmVsUGVybWlzc2lvbnMgPSBzY2hlbWFDb250cm9sbGVyLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpO1xuICAgICAgY29uc3Qgb3AgPSB0aGlzLl9nZXRDTFBPcGVyYXRpb24ocmVxdWVzdC5xdWVyeSk7XG4gICAgICBjb25zdCBhY2xHcm91cCA9IFsnKiddO1xuICAgICAgaWYgKCFhdXRoQ2FsbGVkKSB7XG4gICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCB0aGlzLmdldEF1dGhGcm9tQ2xpZW50KFxuICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICByZXF1ZXN0LnJlcXVlc3RJZCxcbiAgICAgICAgICByZXF1ZXN0LnNlc3Npb25Ub2tlblxuICAgICAgICApO1xuICAgICAgICBhdXRoQ2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB7XG4gICAgICAgICAgcmVxdWVzdC51c2VyID0gYXV0aC51c2VyO1xuICAgICAgICAgIGFjbEdyb3VwLnB1c2goYXV0aC51c2VyLmlkKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChyZXF1ZXN0LnVzZXIpIHtcbiAgICAgICAgYWNsR3JvdXAucHVzaChyZXF1ZXN0LnVzZXIuaWQpO1xuICAgICAgfVxuICAgICAgYXdhaXQgU2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oXG4gICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgb3BcbiAgICAgICk7XG5cbiAgICAgIC8vIENoZWNrIHByb3RlY3RlZCBmaWVsZHMgaW4gV0hFUkUgY2xhdXNlIGFuZCBXQVRDSCBwYXJhbWV0ZXJcbiAgICAgIGlmICghY2xpZW50Lmhhc01hc3RlcktleSkge1xuICAgICAgICBjb25zdCBhdXRoID0gcmVxdWVzdC51c2VyID8geyB1c2VyOiByZXF1ZXN0LnVzZXIsIHVzZXJSb2xlczogW10gfSA6IHt9O1xuICAgICAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPVxuICAgICAgICAgIGFwcENvbmZpZy5kYXRhYmFzZS5hZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICByZXF1ZXN0LnF1ZXJ5LndoZXJlLFxuICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICBhdXRoXG4gICAgICAgICAgKSB8fCBbXTtcbiAgICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5sZW5ndGggPiAwICYmIHJlcXVlc3QucXVlcnkud2hlcmUpIHtcbiAgICAgICAgICBjb25zdCBjaGVja1doZXJlID0gKHdoZXJlOiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygd2hlcmUgIT09ICdvYmplY3QnIHx8IHdoZXJlID09PSBudWxsKSB7XG4gICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZvciAoY29uc3Qgd2hlcmVLZXkgb2YgT2JqZWN0LmtleXMod2hlcmUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZCA9IHdoZXJlS2V5LnNwbGl0KCcuJylbMF07XG4gICAgICAgICAgICAgIGlmIChwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMod2hlcmVLZXkpIHx8IHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyhyb290RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICAgICAgICdQZXJtaXNzaW9uIGRlbmllZCdcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmb3IgKGNvbnN0IG9wIG9mIFsnJG9yJywgJyRhbmQnLCAnJG5vciddKSB7XG4gICAgICAgICAgICAgIGlmICh3aGVyZVtvcF0gIT09IHVuZGVmaW5lZCAmJiAhQXJyYXkuaXNBcnJheSh3aGVyZVtvcF0pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIGAke29wfSBtdXN0IGJlIGFuIGFycmF5YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkod2hlcmVbb3BdKSkge1xuICAgICAgICAgICAgICAgIHdoZXJlW29wXS5mb3JFYWNoKChzdWJRdWVyeTogYW55KSA9PiBjaGVja1doZXJlKHN1YlF1ZXJ5KSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9O1xuICAgICAgICAgIGNoZWNrV2hlcmUocmVxdWVzdC5xdWVyeS53aGVyZSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5sZW5ndGggPiAwICYmIEFycmF5LmlzQXJyYXkocmVxdWVzdC5xdWVyeS53YXRjaCkpIHtcbiAgICAgICAgICBmb3IgKGNvbnN0IHdhdGNoRmllbGQgb2YgcmVxdWVzdC5xdWVyeS53YXRjaCkge1xuICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkID0gd2F0Y2hGaWVsZC5zcGxpdCgnLicpWzBdO1xuICAgICAgICAgICAgaWYgKHByb3RlY3RlZEZpZWxkcy5pbmNsdWRlcyh3YXRjaEZpZWxkKSB8fCBwcm90ZWN0ZWRGaWVsZHMuaW5jbHVkZXMocm9vdEZpZWxkKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgICAgICAnUGVybWlzc2lvbiBkZW5pZWQnXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIHJlZ2V4IHBhdHRlcm5zIGluIHRoZSBzdWJzY3JpcHRpb24gcXVlcnlcbiAgICAgIHRoaXMuX3ZhbGlkYXRlUXVlcnlDb25zdHJhaW50cyhyZXF1ZXN0LnF1ZXJ5LndoZXJlKTtcblxuICAgICAgLy8gSWYgdGhpcyBjbGllbnQgYWxyZWFkeSBoYXMgYSBzdWJzY3JpcHRpb24gcmVnaXN0ZXJlZCB1bmRlciB0aGlzXG4gICAgICAvLyByZXF1ZXN0SWQsIHJlcGxhY2UgaXQgYnkgdGVhcmluZyBkb3duIHRoZSBwcmV2aW91cyBzdWJzY3JpcHRpb24gYmVmb3JlXG4gICAgICAvLyBjcmVhdGluZyB0aGUgbmV3IG9uZS4gVGhlIGNsaWVudC1zaWRlIG1ldGFkYXRhIG1hcCBpcyBrZXllZCBvbmx5IGJ5XG4gICAgICAvLyByZXF1ZXN0SWQsIHNvIGEgZHVwbGljYXRlIGBzdWJzY3JpYmVgIGZyYW1lIHdvdWxkIG90aGVyd2lzZSBvdmVyd3JpdGUgaXRcbiAgICAgIC8vIHdoaWxlIHRoZSBwcmV2aW91cyBTdWJzY3JpcHRpb24gc3RheXMgaW4gdGhlIHNlcnZlci13aWRlIG1hcCwgbGVha2luZyBpdFxuICAgICAgLy8gZm9yIHRoZSBsaWZldGltZSBvZiB0aGUgcHJvY2VzcyAoZGlzY29ubmVjdCBjbGVhbnVwIG9ubHkgd2Fsa3MgdGhlXG4gICAgICAvLyBzdXJ2aXZpbmcgY2xpZW50IG1ldGFkYXRhIGFuZCBuZXZlciByZWFjaGVzIHRoZSBvcnBoYW5lZCBzdWJzY3JpcHRpb24pLlxuICAgICAgY29uc3QgcHJldmlvdXNTdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdC5yZXF1ZXN0SWQpO1xuICAgICAgaWYgKHByZXZpb3VzU3Vic2NyaXB0aW9uSW5mbykge1xuICAgICAgICBjb25zdCBwcmV2aW91c1N1YnNjcmlwdGlvbiA9IHByZXZpb3VzU3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgICAgIHByZXZpb3VzU3Vic2NyaXB0aW9uLmRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgcmVxdWVzdC5yZXF1ZXN0SWQpO1xuICAgICAgICBjb25zdCBwcmV2aW91c0NsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQocHJldmlvdXNTdWJzY3JpcHRpb24uY2xhc3NOYW1lKTtcbiAgICAgICAgaWYgKHByZXZpb3VzQ2xhc3NTdWJzY3JpcHRpb25zKSB7XG4gICAgICAgICAgaWYgKCFwcmV2aW91c1N1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgICAgICBwcmV2aW91c0NsYXNzU3Vic2NyaXB0aW9ucy5kZWxldGUocHJldmlvdXNTdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChwcmV2aW91c0NsYXNzU3Vic2NyaXB0aW9ucy5zaXplID09PSAwKSB7XG4gICAgICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKHByZXZpb3VzU3Vic2NyaXB0aW9uLmNsYXNzTmFtZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEdldCBzdWJzY3JpcHRpb24gZnJvbSBzdWJzY3JpcHRpb25zLCBjcmVhdGUgb25lIGlmIG5lY2Vzc2FyeVxuICAgICAgY29uc3Qgc3Vic2NyaXB0aW9uSGFzaCA9IHF1ZXJ5SGFzaChyZXF1ZXN0LnF1ZXJ5KTtcbiAgICAgIC8vIEFkZCBjbGFzc05hbWUgdG8gc3Vic2NyaXB0aW9ucyBpZiBuZWNlc3NhcnlcblxuICAgICAgaWYgKCF0aGlzLnN1YnNjcmlwdGlvbnMuaGFzKGNsYXNzTmFtZSkpIHtcbiAgICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLnNldChjbGFzc05hbWUsIG5ldyBNYXAoKSk7XG4gICAgICB9XG4gICAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgICBsZXQgc3Vic2NyaXB0aW9uO1xuICAgICAgaWYgKGNsYXNzU3Vic2NyaXB0aW9ucy5oYXMoc3Vic2NyaXB0aW9uSGFzaCkpIHtcbiAgICAgICAgc3Vic2NyaXB0aW9uID0gY2xhc3NTdWJzY3JpcHRpb25zLmdldChzdWJzY3JpcHRpb25IYXNoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN1YnNjcmlwdGlvbiA9IG5ldyBTdWJzY3JpcHRpb24oY2xhc3NOYW1lLCByZXF1ZXN0LnF1ZXJ5LndoZXJlLCBzdWJzY3JpcHRpb25IYXNoKTtcbiAgICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLnNldChzdWJzY3JpcHRpb25IYXNoLCBzdWJzY3JpcHRpb24pO1xuICAgICAgfVxuXG4gICAgICAvLyBBZGQgc3Vic2NyaXB0aW9uSW5mbyB0byBjbGllbnRcbiAgICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm86IGFueSA9IHtcbiAgICAgICAgc3Vic2NyaXB0aW9uOiBzdWJzY3JpcHRpb24sXG4gICAgICB9O1xuICAgICAgLy8gQWRkIHNlbGVjdGVkIGZpZWxkcywgc2Vzc2lvblRva2VuIGFuZCBpbnN0YWxsYXRpb25JZCBmb3IgdGhpcyBzdWJzY3JpcHRpb24gaWYgbmVjZXNzYXJ5XG4gICAgICBpZiAocmVxdWVzdC5xdWVyeS5rZXlzKSB7XG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8ua2V5cyA9IEFycmF5LmlzQXJyYXkocmVxdWVzdC5xdWVyeS5rZXlzKVxuICAgICAgICAgID8gcmVxdWVzdC5xdWVyeS5rZXlzXG4gICAgICAgICAgOiByZXF1ZXN0LnF1ZXJ5LmtleXMuc3BsaXQoJywnKTtcbiAgICAgIH1cbiAgICAgIGlmIChyZXF1ZXN0LnF1ZXJ5LndhdGNoKSB7XG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8ud2F0Y2ggPSByZXF1ZXN0LnF1ZXJ5LndhdGNoO1xuICAgICAgfVxuICAgICAgaWYgKHJlcXVlc3Quc2Vzc2lvblRva2VuKSB7XG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuID0gcmVxdWVzdC5zZXNzaW9uVG9rZW47XG4gICAgICB9XG4gICAgICBjbGllbnQuYWRkU3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0LnJlcXVlc3RJZCwgc3Vic2NyaXB0aW9uSW5mbyk7XG5cbiAgICAgIC8vIEFkZCBjbGllbnRJZCB0byBzdWJzY3JpcHRpb25cbiAgICAgIHN1YnNjcmlwdGlvbi5hZGRDbGllbnRTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgICAgY2xpZW50LnB1c2hTdWJzY3JpYmUocmVxdWVzdC5yZXF1ZXN0SWQpO1xuXG4gICAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICAgYENyZWF0ZSBjbGllbnQgJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH0gbmV3IHN1YnNjcmlwdGlvbjogJHtyZXF1ZXN0LnJlcXVlc3RJZH1gXG4gICAgICApO1xuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlcjogJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG4gICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgY2xpZW50LFxuICAgICAgICBldmVudDogJ3N1YnNjcmliZScsXG4gICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgc2Vzc2lvblRva2VuOiByZXF1ZXN0LnNlc3Npb25Ub2tlbixcbiAgICAgICAgdXNlTWFzdGVyS2V5OiBjbGllbnQuaGFzTWFzdGVyS2V5LFxuICAgICAgICBpbnN0YWxsYXRpb25JZDogY2xpZW50Lmluc3RhbGxhdGlvbklkLFxuICAgICAgfSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgZXJyb3IgPSByZXNvbHZlRXJyb3IoZSk7XG4gICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCBlcnJvci5jb2RlLCBlcnJvci5tZXNzYWdlLCBmYWxzZSwgcmVxdWVzdC5yZXF1ZXN0SWQpO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICBgRmFpbGVkIHJ1bm5pbmcgYmVmb3JlU3Vic2NyaWJlIG9uICR7Y2xhc3NOYW1lfSBmb3Igc2Vzc2lvbiAke3JlcXVlc3Quc2Vzc2lvblRva2VufSB3aXRoOlxcbiBFcnJvcjogYCArXG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoZXJyb3IpXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIF9oYW5kbGVVcGRhdGVTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICB0aGlzLl9oYW5kbGVVbnN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCwgZmFsc2UpO1xuICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gIH1cblxuICBfaGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55LCBub3RpZnlDbGllbnQ6IGJvb2xlYW4gPSB0cnVlKTogYW55IHtcbiAgICAvLyBJZiB3ZSBjYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIHJldHVybiBlcnJvciB0byBjbGllbnRcbiAgICBpZiAoIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChwYXJzZVdlYnNvY2tldCwgJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJlcXVlc3RJZCA9IHJlcXVlc3QucmVxdWVzdElkO1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihcbiAgICAgICAgcGFyc2VXZWJzb2NrZXQsXG4gICAgICAgIDIsXG4gICAgICAgICdDYW5ub3QgZmluZCBjbGllbnQgd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJy4gTWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIGxpdmUgcXVlcnkgc2VydmVyIGJlZm9yZSB1bnN1YnNjcmliaW5nLidcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCAnICsgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2Fubm90IGZpbmQgc3Vic2NyaXB0aW9uIHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcgc3Vic2NyaXB0aW9uSWQgJyArXG4gICAgICAgICAgcmVxdWVzdElkICtcbiAgICAgICAgICAnLiBNYWtlIHN1cmUgeW91IHN1YnNjcmliZSB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgK1xuICAgICAgICAgIHJlcXVlc3RJZFxuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgc3Vic2NyaXB0aW9uIGZyb20gY2xpZW50XG4gICAgY2xpZW50LmRlbGV0ZVN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICAvLyBSZW1vdmUgY2xpZW50IGZyb20gc3Vic2NyaXB0aW9uXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uID0gc3Vic2NyaXB0aW9uSW5mby5zdWJzY3JpcHRpb247XG4gICAgY29uc3QgY2xhc3NOYW1lID0gc3Vic2NyaXB0aW9uLmNsYXNzTmFtZTtcbiAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LmNsaWVudElkLCByZXF1ZXN0SWQpO1xuICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zKSB7XG4gICAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmhhc2gpO1xuICAgICAgfVxuICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLnNpemUgPT09IDApIHtcbiAgICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLmRlbGV0ZShjbGFzc05hbWUpO1xuICAgICAgfVxuICAgIH1cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGNsaWVudCxcbiAgICAgIGV2ZW50OiAndW5zdWJzY3JpYmUnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgIHNlc3Npb25Ub2tlbjogc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4sXG4gICAgICB1c2VNYXN0ZXJLZXk6IGNsaWVudC5oYXNNYXN0ZXJLZXksXG4gICAgICBpbnN0YWxsYXRpb25JZDogY2xpZW50Lmluc3RhbGxhdGlvbklkLFxuICAgIH0pO1xuXG4gICAgaWYgKCFub3RpZnlDbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjbGllbnQucHVzaFVuc3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgYERlbGV0ZSBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9IHwgc3Vic2NyaXB0aW9uOiAke3JlcXVlc3QucmVxdWVzdElkfWBcbiAgICApO1xuICB9XG59XG5cbmV4cG9ydCB7IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyIH07XG4iXSwibWFwcGluZ3MiOiI7Ozs7OztBQUFBLElBQUFBLEdBQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLEtBQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFFLGFBQUEsR0FBQUYsT0FBQTtBQUNBLElBQUFHLE9BQUEsR0FBQUgsT0FBQTtBQUNBLElBQUFJLHFCQUFBLEdBQUFKLE9BQUE7QUFFQSxJQUFBSyxPQUFBLEdBQUFOLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBTSxjQUFBLEdBQUFQLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBTyxXQUFBLEdBQUFQLE9BQUE7QUFDQSxJQUFBUSxZQUFBLEdBQUFSLE9BQUE7QUFDQSxJQUFBUyxpQkFBQSxHQUFBVixzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVUsT0FBQSxHQUFBWCxzQkFBQSxDQUFBQyxPQUFBO0FBQ0EsSUFBQVcsT0FBQSxHQUFBWCxPQUFBO0FBQ0EsSUFBQVksU0FBQSxHQUFBWixPQUFBO0FBT0EsSUFBQWEsS0FBQSxHQUFBYixPQUFBO0FBQ0EsSUFBQWMsWUFBQSxHQUFBZCxPQUFBO0FBQ0EsSUFBQWUsT0FBQSxHQUFBaEIsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFnQixTQUFBLEdBQUFoQixPQUFBO0FBQ0EsSUFBQWlCLFlBQUEsR0FBQWxCLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBa0IsbUJBQUEsR0FBQW5CLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBbUIsS0FBQSxHQUFBbkIsT0FBQTtBQUF5QyxTQUFBRCx1QkFBQXFCLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxL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