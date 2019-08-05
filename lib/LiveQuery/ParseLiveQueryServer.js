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

var _uuid = _interopRequireDefault(require("uuid"));

var _triggers = require("../triggers");

var _Auth = require("../Auth");

var _Controllers = require("../Controllers");

var _lruCache = _interopRequireDefault(require("lru-cache"));

var _UsersRouter = _interopRequireDefault(require("../Routers/UsersRouter"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)
  // The subscriber we use to get object update from publisher
  constructor(server, config = {}) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();
    config.appId = config.appId || _node.default.applicationId;
    config.masterKey = config.masterKey || _node.default.masterKey; // Store keys, convert obj to map

    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();

    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }

    _logger.default.verbose('Support key pairs', this.keyPairs); // Initialize Parse


    _node.default.Object.disableSingleInstance();

    const serverURL = config.serverURL || _node.default.serverURL;
    _node.default.serverURL = serverURL;

    _node.default.initialize(config.appId, _node.default.javaScriptKey, config.masterKey); // The cache controller is a proper cache controller
    // with access to User and Roles


    this.cacheController = (0, _Controllers.getCacheController)(config); // This auth cache stores the promises for each auth resolution.
    // The main benefit is to be able to reuse the same user / session token resolution.

    this.authCache = new _lruCache.default({
      max: 500,
      // 500 concurrent
      maxAge: 60 * 60 * 1000 // 1h

    }); // Initialize websocket server

    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config); // Initialize subscriber

    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    this.subscriber.subscribe(_node.default.applicationId + 'afterSave');
    this.subscriber.subscribe(_node.default.applicationId + 'afterDelete'); // Register message handler for subscriber. When publisher get messages, it will publish message
    // to the subscribers and the handler will be called.

    this.subscriber.on('message', (channel, messageStr) => {
      _logger.default.verbose('Subscribe messsage %j', messageStr);

      let message;

      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger.default.error('unable to parse message', messageStr, e);

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
    });
  } // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.


  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;

    _UsersRouter.default.removeHiddenProperties(currentParseObject);

    let className = currentParseObject.className;
    let parseObject = new _node.default.Object(className);

    parseObject._finishFetch(currentParseObject);

    message.currentParseObject = parseObject; // Inflate original object

    const originalParseObject = message.originalParseObject;

    if (originalParseObject) {
      _UsersRouter.default.removeHiddenProperties(originalParseObject);

      className = originalParseObject.className;
      parseObject = new _node.default.Object(className);

      parseObject._finishFetch(originalParseObject);

      message.originalParseObject = parseObject;
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterDelete(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterDelete is triggered');

    const deletedParseObject = message.currentParseObject.toJSON();
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
      const isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);

      if (!isSubscriptionMatched) {
        continue;
      }

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
          const acl = message.currentParseObject.getACL(); // Check CLP

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            // Check ACL
            return this._matchesACL(acl, client, requestId);
          }).then(isMatched => {
            if (!isMatched) {
              return null;
            }

            client.pushDelete(requestId, deletedParseObject);
          }).catch(error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  } // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.


  _onAfterSave(message) {
    _logger.default.verbose(_node.default.applicationId + 'afterSave is triggered');

    let originalParseObject = null;

    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }

    const classLevelPermissions = message.classLevelPermissions;
    const currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;

    _logger.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);

    _logger.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);

    if (typeof classSubscriptions === 'undefined') {
      _logger.default.debug('Can not find subscriptions under this class ' + className);

      return;
    }

    for (const subscription of classSubscriptions.values()) {
      const isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);

      const isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);

      for (const [clientId, requestIds] of _lodash.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);

        if (typeof client === 'undefined') {
          continue;
        }

        for (const requestId of requestIds) {
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
          } // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL


          let currentACLCheckingPromise;

          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }

          const op = this._getCLPOperation(subscription.query);

          this._matchesCLP(classLevelPermissions, message.currentParseObject, client, requestId, op).then(() => {
            return Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]);
          }).then(([isOriginalMatched, isCurrentMatched]) => {
            _logger.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', originalParseObject, currentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash); // Decide event type


            let type;

            if (isOriginalMatched && isCurrentMatched) {
              type = 'Update';
            } else if (isOriginalMatched && !isCurrentMatched) {
              type = 'Leave';
            } else if (!isOriginalMatched && isCurrentMatched) {
              if (originalParseObject) {
                type = 'Enter';
              } else {
                type = 'Create';
              }
            } else {
              return null;
            }

            const functionName = 'push' + type;
            client[functionName](requestId, currentParseObject, originalParseObject);
          }, error => {
            _logger.default.error('Matching ACL error : ', error);
          });
        }
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

      _logger.default.verbose('Request: %j', request); // Check whether this request is a valid request, return error directly if not


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
      } // Delete client


      const client = this.clients.get(clientId);
      this.clients.delete(clientId); // Delete client from subscriptions

      for (const [requestId, subscriptionInfo] of _lodash.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

        const classSubscriptions = this.subscriptions.get(subscription.className);

        if (!subscription.hasSubscribingClient()) {
          classSubscriptions.delete(subscription.hash);
        } // If there is no subscriptions under this class, remove it from subscriptions


        if (classSubscriptions.size === 0) {
          this.subscriptions.delete(subscription.className);
        }
      }

      _logger.default.verbose('Current clients %d', this.clients.size);

      _logger.default.verbose('Current subscriptions %d', this.subscriptions.size);

      (0, _triggers.runLiveQueryEventHandlers)({
        event: 'ws_disconnect',
        clients: this.clients.size,
        subscriptions: this.subscriptions.size
      });
    });
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'ws_connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _matchesSubscription(parseObject, subscription) {
    // Object is undefined or null, not match
    if (!parseObject) {
      return false;
    }

    return (0, _QueryTools.matchesQuery)(parseObject, subscription.query);
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
        // Store a resolved promise with the error for 10 minutes
        result.error = error;
        this.authCache.set(sessionToken, Promise.resolve(result), 60 * 10 * 1000);
      } else {
        this.authCache.del(sessionToken);
      }

      return result;
    });
    this.authCache.set(sessionToken, authPromise);
    return authPromise;
  }

  async _matchesCLP(classLevelPermissions, object, client, requestId, op) {
    // try to match on user first, less expensive than with roles
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    const aclGroup = ['*'];
    let userId;

    if (typeof subscriptionInfo !== 'undefined') {
      const {
        userId
      } = await this.getAuthForSessionToken(subscriptionInfo.sessionToken);

      if (userId) {
        aclGroup.push(userId);
      }
    }

    try {
      await _SchemaController.default.validatePermission(classLevelPermissions, object.className, aclGroup, op);
      return true;
    } catch (e) {
      _logger.default.verbose(`Failed matching CLP for ${object.id} ${userId} ${e}`);

      return false;
    } // TODO: handle roles permissions
    // Object.keys(classLevelPermissions).forEach((key) => {
    //   const perm = classLevelPermissions[key];
    //   Object.keys(perm).forEach((key) => {
    //     if (key.indexOf('role'))
    //   });
    // })
    // // it's rejected here, check the roles
    // var rolesQuery = new Parse.Query(Parse.Role);
    // rolesQuery.equalTo("users", user);
    // return rolesQuery.find({useMasterKey:true});

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
    } = await this.getAuthForSessionToken(token); // Getting the session token failed
    // This means that no additional auth is available
    // At this point, just bail out as no additional visibility can be inferred.

    if (!auth || !userId) {
      return false;
    }

    const isSubscriptionSessionTokenMatched = acl.getReadAccess(userId);

    if (isSubscriptionSessionTokenMatched) {
      return true;
    } // Check if the user has any roles that match the ACL


    return Promise.resolve().then(async () => {
      // Resolve false right away if the acl doesn't have any roles
      const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith('role:'));

      if (!acl_has_roles) {
        return false;
      }

      const roleNames = await auth.getUserRoles(); // Finally, see if any of the user's roles allow them read access

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

  async _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return true;
    } // Check subscription sessionToken matches ACL first


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

  _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');

      _logger.default.error('Key in request is not valid');

      return;
    }

    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);

    const clientId = (0, _uuid.default)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey);
    parseWebsocket.clientId = clientId;
    this.clients.set(parseWebsocket.clientId, client);

    _logger.default.info(`Create new client: ${parseWebsocket.clientId}`);

    client.pushConnect();
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has('masterKey')) {
      return false;
    }

    if (!request || !request.hasOwnProperty('masterKey')) {
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

  _handleSubscribe(parseWebsocket, request) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
      _Client.Client.pushError(parseWebsocket, 2, 'Can not find this client, make sure you connect to server before subscribing');

      _logger.default.error('Can not find this client, make sure you connect to server before subscribing');

      return;
    }

    const client = this.clients.get(parseWebsocket.clientId); // Get subscription from subscriptions, create one if necessary

    const subscriptionHash = (0, _QueryTools.queryHash)(request.query); // Add className to subscriptions if necessary

    const className = request.query.className;

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
    } // Add subscriptionInfo to client


    const subscriptionInfo = {
      subscription: subscription
    }; // Add selected fields and sessionToken for this subscription if necessary

    if (request.query.fields) {
      subscriptionInfo.fields = request.query.fields;
    }

    if (request.sessionToken) {
      subscriptionInfo.sessionToken = request.sessionToken;
    }

    client.addSubscriptionInfo(request.requestId, subscriptionInfo); // Add clientId to subscription

    subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);
    client.pushSubscribe(request.requestId);

    _logger.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);

    _logger.default.verbose('Current client number: %d', this.clients.size);

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'subscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _handleUpdateSubscription(parseWebsocket, request) {
    this._handleUnsubscribe(parseWebsocket, request, false);

    this._handleSubscribe(parseWebsocket, request);
  }

  _handleUnsubscribe(parseWebsocket, request, notifyClient = true) {
    // If we can not find this client, return error to client
    if (!parseWebsocket.hasOwnProperty('clientId')) {
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
    } // Remove subscription from client


    client.deleteSubscriptionInfo(requestId); // Remove client from subscription

    const subscription = subscriptionInfo.subscription;
    const className = subscription.className;
    subscription.deleteClientSubscription(parseWebsocket.clientId, requestId); // If there is no client which is subscribing this subscription, remove it from subscriptions

    const classSubscriptions = this.subscriptions.get(className);

    if (!subscription.hasSubscribingClient()) {
      classSubscriptions.delete(subscription.hash);
    } // If there is no subscriptions under this class, remove it from subscriptions


    if (classSubscriptions.size === 0) {
      this.subscriptions.delete(className);
    }

    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'unsubscribe',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });

    if (!notifyClient) {
      return;
    }

    client.pushUnsubscribe(request.requestId);

    _logger.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }

}

exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXIuanMiXSwibmFtZXMiOlsiUGFyc2VMaXZlUXVlcnlTZXJ2ZXIiLCJjb25zdHJ1Y3RvciIsInNlcnZlciIsImNvbmZpZyIsImNsaWVudHMiLCJNYXAiLCJzdWJzY3JpcHRpb25zIiwiYXBwSWQiLCJQYXJzZSIsImFwcGxpY2F0aW9uSWQiLCJtYXN0ZXJLZXkiLCJrZXlQYWlycyIsImtleSIsIk9iamVjdCIsImtleXMiLCJzZXQiLCJsb2dnZXIiLCJ2ZXJib3NlIiwiZGlzYWJsZVNpbmdsZUluc3RhbmNlIiwic2VydmVyVVJMIiwiaW5pdGlhbGl6ZSIsImphdmFTY3JpcHRLZXkiLCJjYWNoZUNvbnRyb2xsZXIiLCJhdXRoQ2FjaGUiLCJMUlUiLCJtYXgiLCJtYXhBZ2UiLCJwYXJzZVdlYlNvY2tldFNlcnZlciIsIlBhcnNlV2ViU29ja2V0U2VydmVyIiwicGFyc2VXZWJzb2NrZXQiLCJfb25Db25uZWN0Iiwic3Vic2NyaWJlciIsIlBhcnNlUHViU3ViIiwiY3JlYXRlU3Vic2NyaWJlciIsInN1YnNjcmliZSIsIm9uIiwiY2hhbm5lbCIsIm1lc3NhZ2VTdHIiLCJtZXNzYWdlIiwiSlNPTiIsInBhcnNlIiwiZSIsImVycm9yIiwiX2luZmxhdGVQYXJzZU9iamVjdCIsIl9vbkFmdGVyU2F2ZSIsIl9vbkFmdGVyRGVsZXRlIiwiY3VycmVudFBhcnNlT2JqZWN0IiwiVXNlclJvdXRlciIsInJlbW92ZUhpZGRlblByb3BlcnRpZXMiLCJjbGFzc05hbWUiLCJwYXJzZU9iamVjdCIsIl9maW5pc2hGZXRjaCIsIm9yaWdpbmFsUGFyc2VPYmplY3QiLCJkZWxldGVkUGFyc2VPYmplY3QiLCJ0b0pTT04iLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpZCIsInNpemUiLCJjbGFzc1N1YnNjcmlwdGlvbnMiLCJnZXQiLCJkZWJ1ZyIsInN1YnNjcmlwdGlvbiIsInZhbHVlcyIsImlzU3Vic2NyaXB0aW9uTWF0Y2hlZCIsIl9tYXRjaGVzU3Vic2NyaXB0aW9uIiwiY2xpZW50SWQiLCJyZXF1ZXN0SWRzIiwiXyIsImVudHJpZXMiLCJjbGllbnRSZXF1ZXN0SWRzIiwiY2xpZW50IiwicmVxdWVzdElkIiwiYWNsIiwiZ2V0QUNMIiwib3AiLCJfZ2V0Q0xQT3BlcmF0aW9uIiwicXVlcnkiLCJfbWF0Y2hlc0NMUCIsInRoZW4iLCJfbWF0Y2hlc0FDTCIsImlzTWF0Y2hlZCIsInB1c2hEZWxldGUiLCJjYXRjaCIsImlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkIiwiaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCIsIm9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlIiwiUHJvbWlzZSIsInJlc29sdmUiLCJvcmlnaW5hbEFDTCIsImN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UiLCJjdXJyZW50QUNMIiwiYWxsIiwiaXNPcmlnaW5hbE1hdGNoZWQiLCJpc0N1cnJlbnRNYXRjaGVkIiwiaGFzaCIsInR5cGUiLCJmdW5jdGlvbk5hbWUiLCJyZXF1ZXN0IiwidHY0IiwidmFsaWRhdGUiLCJSZXF1ZXN0U2NoZW1hIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJldmVudCIsImRlbGV0ZSIsInN1YnNjcmlwdGlvbkluZm8iLCJzdWJzY3JpcHRpb25JbmZvcyIsImRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbiIsImhhc1N1YnNjcmliaW5nQ2xpZW50IiwiZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiIsInNlc3Npb25Ub2tlbiIsImZyb21DYWNoZSIsImF1dGhQcm9taXNlIiwiYXV0aCIsInVzZXJJZCIsInVzZXIiLCJyZXN1bHQiLCJjb2RlIiwiRXJyb3IiLCJJTlZBTElEX1NFU1NJT05fVE9LRU4iLCJkZWwiLCJvYmplY3QiLCJnZXRTdWJzY3JpcHRpb25JbmZvIiwiYWNsR3JvdXAiLCJwdXNoIiwiU2NoZW1hQ29udHJvbGxlciIsInZhbGlkYXRlUGVybWlzc2lvbiIsImxlbmd0aCIsIm9iamVjdElkIiwiX3ZlcmlmeUFDTCIsInRva2VuIiwiaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkIiwiZ2V0UmVhZEFjY2VzcyIsImFjbF9oYXNfcm9sZXMiLCJwZXJtaXNzaW9uc0J5SWQiLCJzb21lIiwic3RhcnRzV2l0aCIsInJvbGVOYW1lcyIsImdldFVzZXJSb2xlcyIsInJvbGUiLCJnZXRQdWJsaWNSZWFkQWNjZXNzIiwiaGFzTWFzdGVyS2V5Iiwic3Vic2NyaXB0aW9uVG9rZW4iLCJjbGllbnRTZXNzaW9uVG9rZW4iLCJfdmFsaWRhdGVLZXlzIiwiX2hhc01hc3RlcktleSIsInB1c2hDb25uZWN0IiwidmFsaWRLZXlQYWlycyIsImhhc093blByb3BlcnR5IiwiaXNWYWxpZCIsInNlY3JldCIsInN1YnNjcmlwdGlvbkhhc2giLCJTdWJzY3JpcHRpb24iLCJ3aGVyZSIsImZpZWxkcyIsImFkZFN1YnNjcmlwdGlvbkluZm8iLCJhZGRDbGllbnRTdWJzY3JpcHRpb24iLCJwdXNoU3Vic2NyaWJlIiwibm90aWZ5Q2xpZW50IiwiZGVsZXRlU3Vic2NyaXB0aW9uSW5mbyIsInB1c2hVbnN1YnNjcmliZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQUFBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOzs7O0FBRUEsTUFBTUEsb0JBQU4sQ0FBMkI7QUFFekI7QUFJQTtBQUdBQyxFQUFBQSxXQUFXLENBQUNDLE1BQUQsRUFBY0MsTUFBVyxHQUFHLEVBQTVCLEVBQWdDO0FBQ3pDLFNBQUtELE1BQUwsR0FBY0EsTUFBZDtBQUNBLFNBQUtFLE9BQUwsR0FBZSxJQUFJQyxHQUFKLEVBQWY7QUFDQSxTQUFLQyxhQUFMLEdBQXFCLElBQUlE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RDlGLElBQUFBLE1BQU0sQ0FBQ2dHLGVBQVAsQ0FBdUJyRSxPQUFPLENBQUMxQixTQUEvQjs7QUFFQXZELG9CQUFPQyxPQUFQLENBQ0csa0JBQWlCWSxjQUFjLENBQUNvQyxRQUFTLG9CQUN4Q2dDLE9BQU8sQ0FBQzFCLFNBQ1QsRUFISDtBQUtEOztBQTF2QndCIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR2NCBmcm9tICd0djQnO1xuaW1wb3J0IFBhcnNlIGZyb20gJ3BhcnNlL25vZGUnO1xuaW1wb3J0IHsgU3Vic2NyaXB0aW9uIH0gZnJvbSAnLi9TdWJzY3JpcHRpb24nO1xuaW1wb3J0IHsgQ2xpZW50IH0gZnJvbSAnLi9DbGllbnQnO1xuaW1wb3J0IHsgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIgfSBmcm9tICcuL1BhcnNlV2ViU29ja2V0U2VydmVyJztcbmltcG9ydCBsb2dnZXIgZnJvbSAnLi4vbG9nZ2VyJztcbmltcG9ydCBSZXF1ZXN0U2NoZW1hIGZyb20gJy4vUmVxdWVzdFNjaGVtYSc7XG5pbXBvcnQgeyBtYXRjaGVzUXVlcnksIHF1ZXJ5SGFzaCB9IGZyb20gJy4vUXVlcnlUb29scyc7XG5pbXBvcnQgeyBQYXJzZVB1YlN1YiB9IGZyb20gJy4vUGFyc2VQdWJTdWInO1xuaW1wb3J0IFNjaGVtYUNvbnRyb2xsZXIgZnJvbSAnLi4vQ29udHJvbGxlcnMvU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgeyBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIH0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuaW1wb3J0IHsgZ2V0QXV0aEZvclNlc3Npb25Ub2tlbiwgQXV0aCB9IGZyb20gJy4uL0F1dGgnO1xuaW1wb3J0IHsgZ2V0Q2FjaGVDb250cm9sbGVyIH0gZnJvbSAnLi4vQ29udHJvbGxlcnMnO1xuaW1wb3J0IExSVSBmcm9tICdscnUtY2FjaGUnO1xuaW1wb3J0IFVzZXJSb3V0ZXIgZnJvbSAnLi4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5cbmNsYXNzIFBhcnNlTGl2ZVF1ZXJ5U2VydmVyIHtcbiAgY2xpZW50czogTWFwO1xuICAvLyBjbGFzc05hbWUgLT4gKHF1ZXJ5SGFzaCAtPiBzdWJzY3JpcHRpb24pXG4gIHN1YnNjcmlwdGlvbnM6IE9iamVjdDtcbiAgcGFyc2VXZWJTb2NrZXRTZXJ2ZXI6IE9iamVjdDtcbiAga2V5UGFpcnM6IGFueTtcbiAgLy8gVGhlIHN1YnNjcmliZXIgd2UgdXNlIHRvIGdldCBvYmplY3QgdXBkYXRlIGZyb20gcHVibGlzaGVyXG4gIHN1YnNjcmliZXI6IE9iamVjdDtcblxuICBjb25zdHJ1Y3RvcihzZXJ2ZXI6IGFueSwgY29uZmlnOiBhbnkgPSB7fSkge1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuICAgIHRoaXMuY2xpZW50cyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG5cbiAgICBjb25maWcuYXBwSWQgPSBjb25maWcuYXBwSWQgfHwgUGFyc2UuYXBwbGljYXRpb25JZDtcbiAgICBjb25maWcubWFzdGVyS2V5ID0gY29uZmlnLm1hc3RlcktleSB8fCBQYXJzZS5tYXN0ZXJLZXk7XG5cbiAgICAvLyBTdG9yZSBrZXlzLCBjb252ZXJ0IG9iaiB0byBtYXBcbiAgICBjb25zdCBrZXlQYWlycyA9IGNvbmZpZy5rZXlQYWlycyB8fCB7fTtcbiAgICB0aGlzLmtleVBhaXJzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGtleVBhaXJzKSkge1xuICAgICAgdGhpcy5rZXlQYWlycy5zZXQoa2V5LCBrZXlQYWlyc1trZXldKTtcbiAgICB9XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ1N1cHBvcnQga2V5IHBhaXJzJywgdGhpcy5rZXlQYWlycyk7XG5cbiAgICAvLyBJbml0aWFsaXplIFBhcnNlXG4gICAgUGFyc2UuT2JqZWN0LmRpc2FibGVTaW5nbGVJbnN0YW5jZSgpO1xuICAgIGNvbnN0IHNlcnZlclVSTCA9IGNvbmZpZy5zZXJ2ZXJVUkwgfHwgUGFyc2Uuc2VydmVyVVJMO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcbiAgICBQYXJzZS5pbml0aWFsaXplKGNvbmZpZy5hcHBJZCwgUGFyc2UuamF2YVNjcmlwdEtleSwgY29uZmlnLm1hc3RlcktleSk7XG5cbiAgICAvLyBUaGUgY2FjaGUgY29udHJvbGxlciBpcyBhIHByb3BlciBjYWNoZSBjb250cm9sbGVyXG4gICAgLy8gd2l0aCBhY2Nlc3MgdG8gVXNlciBhbmQgUm9sZXNcbiAgICB0aGlzLmNhY2hlQ29udHJvbGxlciA9IGdldENhY2hlQ29udHJvbGxlcihjb25maWcpO1xuXG4gICAgLy8gVGhpcyBhdXRoIGNhY2hlIHN0b3JlcyB0aGUgcHJvbWlzZXMgZm9yIGVhY2ggYXV0aCByZXNvbHV0aW9uLlxuICAgIC8vIFRoZSBtYWluIGJlbmVmaXQgaXMgdG8gYmUgYWJsZSB0byByZXVzZSB0aGUgc2FtZSB1c2VyIC8gc2Vzc2lvbiB0b2tlbiByZXNvbHV0aW9uLlxuICAgIHRoaXMuYXV0aENhY2hlID0gbmV3IExSVSh7XG4gICAgICBtYXg6IDUwMCwgLy8gNTAwIGNvbmN1cnJlbnRcbiAgICAgIG1heEFnZTogNjAgKiA2MCAqIDEwMDAsIC8vIDFoXG4gICAgfSk7XG4gICAgLy8gSW5pdGlhbGl6ZSB3ZWJzb2NrZXQgc2VydmVyXG4gICAgdGhpcy5wYXJzZVdlYlNvY2tldFNlcnZlciA9IG5ldyBQYXJzZVdlYlNvY2tldFNlcnZlcihcbiAgICAgIHNlcnZlcixcbiAgICAgIHBhcnNlV2Vic29ja2V0ID0+IHRoaXMuX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldCksXG4gICAgICBjb25maWdcbiAgICApO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzdWJzY3JpYmVyXG4gICAgdGhpcy5zdWJzY3JpYmVyID0gUGFyc2VQdWJTdWIuY3JlYXRlU3Vic2NyaWJlcihjb25maWcpO1xuICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKTtcbiAgICB0aGlzLnN1YnNjcmliZXIuc3Vic2NyaWJlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKTtcbiAgICAvLyBSZWdpc3RlciBtZXNzYWdlIGhhbmRsZXIgZm9yIHN1YnNjcmliZXIuIFdoZW4gcHVibGlzaGVyIGdldCBtZXNzYWdlcywgaXQgd2lsbCBwdWJsaXNoIG1lc3NhZ2VcbiAgICAvLyB0byB0aGUgc3Vic2NyaWJlcnMgYW5kIHRoZSBoYW5kbGVyIHdpbGwgYmUgY2FsbGVkLlxuICAgIHRoaXMuc3Vic2NyaWJlci5vbignbWVzc2FnZScsIChjaGFubmVsLCBtZXNzYWdlU3RyKSA9PiB7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnU3Vic2NyaWJlIG1lc3NzYWdlICVqJywgbWVzc2FnZVN0cik7XG4gICAgICBsZXQgbWVzc2FnZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIG1lc3NhZ2UgPSBKU09OLnBhcnNlKG1lc3NhZ2VTdHIpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSBtZXNzYWdlJywgbWVzc2FnZVN0ciwgZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2luZmxhdGVQYXJzZU9iamVjdChtZXNzYWdlKTtcbiAgICAgIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyU2F2ZScpIHtcbiAgICAgICAgdGhpcy5fb25BZnRlclNhdmUobWVzc2FnZSk7XG4gICAgICB9IGVsc2UgaWYgKGNoYW5uZWwgPT09IFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJEZWxldGUobWVzc2FnZSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICAgJ0dldCBtZXNzYWdlICVzIGZyb20gdW5rbm93biBjaGFubmVsICVqJyxcbiAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgIGNoYW5uZWxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgSlNPTiBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0IEpTT04uXG4gIF9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgLy8gSW5mbGF0ZSBtZXJnZWQgb2JqZWN0XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3Q7XG4gICAgVXNlclJvdXRlci5yZW1vdmVIaWRkZW5Qcm9wZXJ0aWVzKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbGV0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbGV0IHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgIHBhcnNlT2JqZWN0Ll9maW5pc2hGZXRjaChjdXJyZW50UGFyc2VPYmplY3QpO1xuICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgLy8gSW5mbGF0ZSBvcmlnaW5hbCBvYmplY3RcbiAgICBjb25zdCBvcmlnaW5hbFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0O1xuICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICBVc2VyUm91dGVyLnJlbW92ZUhpZGRlblByb3BlcnRpZXMob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBjbGFzc05hbWUgPSBvcmlnaW5hbFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICAgIHBhcnNlT2JqZWN0ID0gbmV3IFBhcnNlLk9iamVjdChjbGFzc05hbWUpO1xuICAgICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKG9yaWdpbmFsUGFyc2VPYmplY3QpO1xuICAgICAgbWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0ID0gcGFyc2VPYmplY3Q7XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlckRlbGV0ZShtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICBsb2dnZXIudmVyYm9zZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgY29uc3QgZGVsZXRlZFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gZGVsZXRlZFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVqIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzU3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGRlbGV0ZWRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgaWYgKCFpc1N1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtjbGllbnRJZCwgcmVxdWVzdElkc10gb2YgXy5lbnRyaWVzKFxuICAgICAgICBzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkc1xuICAgICAgKSkge1xuICAgICAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KGNsaWVudElkKTtcbiAgICAgICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCByZXF1ZXN0SWQgb2YgcmVxdWVzdElkcykge1xuICAgICAgICAgIGNvbnN0IGFjbCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgIC8vIENoZWNrIENMUFxuICAgICAgICAgIGNvbnN0IG9wID0gdGhpcy5fZ2V0Q0xQT3BlcmF0aW9uKHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gICAgICAgICAgdGhpcy5fbWF0Y2hlc0NMUChcbiAgICAgICAgICAgIGNsYXNzTGV2ZWxQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgY2xpZW50LFxuICAgICAgICAgICAgcmVxdWVzdElkLFxuICAgICAgICAgICAgb3BcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgIC8vIENoZWNrIEFDTFxuICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fbWF0Y2hlc0FDTChhY2wsIGNsaWVudCwgcmVxdWVzdElkKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAudGhlbihpc01hdGNoZWQgPT4ge1xuICAgICAgICAgICAgICBpZiAoIWlzTWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGNsaWVudC5wdXNoRGVsZXRlKHJlcXVlc3RJZCwgZGVsZXRlZFBhcnNlT2JqZWN0KTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ01hdGNoaW5nIEFDTCBlcnJvciA6ICcsIGVycm9yKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIgYWZ0ZXIgaW5mbGF0ZWQuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBhZnRlciBjaGFuZ2VzLlxuICAvLyBNZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgaXMgdGhlIG9yaWdpbmFsIFBhcnNlT2JqZWN0LlxuICBfb25BZnRlclNhdmUobWVzc2FnZTogYW55KTogdm9pZCB7XG4gICAgbG9nZ2VyLnZlcmJvc2UoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUgaXMgdHJpZ2dlcmVkJyk7XG5cbiAgICBsZXQgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG51bGw7XG4gICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICB9XG4gICAgY29uc3QgY2xhc3NMZXZlbFBlcm1pc3Npb25zID0gbWVzc2FnZS5jbGFzc0xldmVsUGVybWlzc2lvbnM7XG4gICAgY29uc3QgY3VycmVudFBhcnNlT2JqZWN0ID0gbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgY29uc3QgY2xhc3NOYW1lID0gY3VycmVudFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgICdDbGFzc05hbWU6ICVzIHwgT2JqZWN0SWQ6ICVzJyxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIGN1cnJlbnRQYXJzZU9iamVjdC5pZFxuICAgICk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihcbiAgICAgICAgb3JpZ2luYWxQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgY29uc3QgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oXG4gICAgICAgIGN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgc3Vic2NyaXB0aW9uXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBbY2xpZW50SWQsIHJlcXVlc3RJZHNdIG9mIF8uZW50cmllcyhcbiAgICAgICAgc3Vic2NyaXB0aW9uLmNsaWVudFJlcXVlc3RJZHNcbiAgICAgICkpIHtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgcmVxdWVzdElkIG9mIHJlcXVlc3RJZHMpIHtcbiAgICAgICAgICAvLyBTZXQgb3JpZ25hbCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlO1xuICAgICAgICAgIGlmICghaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IG9yaWdpbmFsQUNMO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChcbiAgICAgICAgICAgICAgb3JpZ2luYWxBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBTZXQgY3VycmVudCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkKSB7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudEFDTCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSA9IHRoaXMuX21hdGNoZXNBQ0woXG4gICAgICAgICAgICAgIGN1cnJlbnRBQ0wsXG4gICAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgICAgcmVxdWVzdElkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBvcCA9IHRoaXMuX2dldENMUE9wZXJhdGlvbihzdWJzY3JpcHRpb24ucXVlcnkpO1xuICAgICAgICAgIHRoaXMuX21hdGNoZXNDTFAoXG4gICAgICAgICAgICBjbGFzc0xldmVsUGVybWlzc2lvbnMsXG4gICAgICAgICAgICBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgICAgIGNsaWVudCxcbiAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgIG9wXG4gICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlLFxuICAgICAgICAgICAgICAgIGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2UsXG4gICAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIC50aGVuKFxuICAgICAgICAgICAgICAoW2lzT3JpZ2luYWxNYXRjaGVkLCBpc0N1cnJlbnRNYXRjaGVkXSkgPT4ge1xuICAgICAgICAgICAgICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgICAgICAgICAgICAgJ09yaWdpbmFsICVqIHwgQ3VycmVudCAlaiB8IE1hdGNoOiAlcywgJXMsICVzLCAlcyB8IFF1ZXJ5OiAlcycsXG4gICAgICAgICAgICAgICAgICBvcmlnaW5hbFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgY3VycmVudFBhcnNlT2JqZWN0LFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgaXNPcmlnaW5hbE1hdGNoZWQsXG4gICAgICAgICAgICAgICAgICBpc0N1cnJlbnRNYXRjaGVkLFxuICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uLmhhc2hcbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgICAgICBsZXQgdHlwZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICAgICAgdHlwZSA9ICdVcGRhdGUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaXNPcmlnaW5hbE1hdGNoZWQgJiYgIWlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIHR5cGUgPSAnTGVhdmUnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgICAgIGlmIChvcmlnaW5hbFBhcnNlT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGUgPSAnRW50ZXInO1xuICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdHlwZSA9ICdDcmVhdGUnO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25OYW1lID0gJ3B1c2gnICsgdHlwZTtcbiAgICAgICAgICAgICAgICBjbGllbnRbZnVuY3Rpb25OYW1lXShcbiAgICAgICAgICAgICAgICAgIHJlcXVlc3RJZCxcbiAgICAgICAgICAgICAgICAgIGN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgICAgICAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3RcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgbG9nZ2VyLmVycm9yKCdNYXRjaGluZyBBQ0wgZXJyb3IgOiAnLCBlcnJvcik7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBfb25Db25uZWN0KHBhcnNlV2Vic29ja2V0OiBhbnkpOiB2b2lkIHtcbiAgICBwYXJzZVdlYnNvY2tldC5vbignbWVzc2FnZScsIHJlcXVlc3QgPT4ge1xuICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0ID09PSAnc3RyaW5nJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcXVlc3QgPSBKU09OLnBhcnNlKHJlcXVlc3QpO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCd1bmFibGUgdG8gcGFyc2UgcmVxdWVzdCcsIHJlcXVlc3QsIGUpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ1JlcXVlc3Q6ICVqJywgcmVxdWVzdCk7XG5cbiAgICAgIC8vIENoZWNrIHdoZXRoZXIgdGhpcyByZXF1ZXN0IGlzIGEgdmFsaWQgcmVxdWVzdCwgcmV0dXJuIGVycm9yIGRpcmVjdGx5IGlmIG5vdFxuICAgICAgaWYgKFxuICAgICAgICAhdHY0LnZhbGlkYXRlKHJlcXVlc3QsIFJlcXVlc3RTY2hlbWFbJ2dlbmVyYWwnXSkgfHxcbiAgICAgICAgIXR2NC52YWxpZGF0ZShyZXF1ZXN0LCBSZXF1ZXN0U2NoZW1hW3JlcXVlc3Qub3BdKVxuICAgICAgKSB7XG4gICAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDEsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdDb25uZWN0IG1lc3NhZ2UgZXJyb3IgJXMnLCB0djQuZXJyb3IubWVzc2FnZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgc3dpdGNoIChyZXF1ZXN0Lm9wKSB7XG4gICAgICAgIGNhc2UgJ2Nvbm5lY3QnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdzdWJzY3JpYmUnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ3VwZGF0ZSc6XG4gICAgICAgICAgdGhpcy5faGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAndW5zdWJzY3JpYmUnOlxuICAgICAgICAgIHRoaXMuX2hhbmRsZVVuc3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAzLCAnR2V0IHVua25vd24gb3BlcmF0aW9uJyk7XG4gICAgICAgICAgbG9nZ2VyLmVycm9yKCdHZXQgdW5rbm93biBvcGVyYXRpb24nLCByZXF1ZXN0Lm9wKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHBhcnNlV2Vic29ja2V0Lm9uKCdkaXNjb25uZWN0JywgKCkgPT4ge1xuICAgICAgbG9nZ2VyLmluZm8oYENsaWVudCBkaXNjb25uZWN0OiAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfWApO1xuICAgICAgY29uc3QgY2xpZW50SWQgPSBwYXJzZVdlYnNvY2tldC5jbGllbnRJZDtcbiAgICAgIGlmICghdGhpcy5jbGllbnRzLmhhcyhjbGllbnRJZCkpIHtcbiAgICAgICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICAgICAgZXZlbnQ6ICd3c19kaXNjb25uZWN0X2Vycm9yJyxcbiAgICAgICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgICAgICBlcnJvcjogYFVuYWJsZSB0byBmaW5kIGNsaWVudCAke2NsaWVudElkfWAsXG4gICAgICAgIH0pO1xuICAgICAgICBsb2dnZXIuZXJyb3IoYENhbiBub3QgZmluZCBjbGllbnQgJHtjbGllbnRJZH0gb24gZGlzY29ubmVjdGApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnRcbiAgICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQoY2xpZW50SWQpO1xuICAgICAgdGhpcy5jbGllbnRzLmRlbGV0ZShjbGllbnRJZCk7XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICBmb3IgKGNvbnN0IFtyZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm9dIG9mIF8uZW50cmllcyhcbiAgICAgICAgY2xpZW50LnN1YnNjcmlwdGlvbkluZm9zXG4gICAgICApKSB7XG4gICAgICAgIGNvbnN0IHN1YnNjcmlwdGlvbiA9IHN1YnNjcmlwdGlvbkluZm8uc3Vic2NyaXB0aW9uO1xuICAgICAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKGNsaWVudElkLCByZXF1ZXN0SWQpO1xuXG4gICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KFxuICAgICAgICAgIHN1YnNjcmlwdGlvbi5jbGFzc05hbWVcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKCFzdWJzY3JpcHRpb24uaGFzU3Vic2NyaWJpbmdDbGllbnQoKSkge1xuICAgICAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmhhc2gpO1xuICAgICAgICB9XG4gICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcywgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLnNpemUgPT09IDApIHtcbiAgICAgICAgICB0aGlzLnN1YnNjcmlwdGlvbnMuZGVsZXRlKHN1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudHMgJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG4gICAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBzdWJzY3JpcHRpb25zICVkJywgdGhpcy5zdWJzY3JpcHRpb25zLnNpemUpO1xuICAgICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICAgIGV2ZW50OiAnd3NfZGlzY29ubmVjdCcsXG4gICAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ3dzX2Nvbm5lY3QnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9tYXRjaGVzU3Vic2NyaXB0aW9uKHBhcnNlT2JqZWN0OiBhbnksIHN1YnNjcmlwdGlvbjogYW55KTogYm9vbGVhbiB7XG4gICAgLy8gT2JqZWN0IGlzIHVuZGVmaW5lZCBvciBudWxsLCBub3QgbWF0Y2hcbiAgICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBtYXRjaGVzUXVlcnkocGFyc2VPYmplY3QsIHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gIH1cblxuICBnZXRBdXRoRm9yU2Vzc2lvblRva2VuKFxuICAgIHNlc3Npb25Ub2tlbjogP3N0cmluZ1xuICApOiBQcm9taXNlPHsgYXV0aDogP0F1dGgsIHVzZXJJZDogP3N0cmluZyB9PiB7XG4gICAgaWYgKCFzZXNzaW9uVG9rZW4pIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoe30pO1xuICAgIH1cbiAgICBjb25zdCBmcm9tQ2FjaGUgPSB0aGlzLmF1dGhDYWNoZS5nZXQoc2Vzc2lvblRva2VuKTtcbiAgICBpZiAoZnJvbUNhY2hlKSB7XG4gICAgICByZXR1cm4gZnJvbUNhY2hlO1xuICAgIH1cbiAgICBjb25zdCBhdXRoUHJvbWlzZSA9IGdldEF1dGhGb3JTZXNzaW9uVG9rZW4oe1xuICAgICAgY2FjaGVDb250cm9sbGVyOiB0aGlzLmNhY2hlQ29udHJvbGxlcixcbiAgICAgIHNlc3Npb25Ub2tlbjogc2Vzc2lvblRva2VuLFxuICAgIH0pXG4gICAgICAudGhlbihhdXRoID0+IHtcbiAgICAgICAgcmV0dXJuIHsgYXV0aCwgdXNlcklkOiBhdXRoICYmIGF1dGgudXNlciAmJiBhdXRoLnVzZXIuaWQgfTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBUaGVyZSB3YXMgYW4gZXJyb3Igd2l0aCB0aGUgc2Vzc2lvbiB0b2tlblxuICAgICAgICBjb25zdCByZXN1bHQgPSB7fTtcbiAgICAgICAgaWYgKGVycm9yICYmIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLklOVkFMSURfU0VTU0lPTl9UT0tFTikge1xuICAgICAgICAgIC8vIFN0b3JlIGEgcmVzb2x2ZWQgcHJvbWlzZSB3aXRoIHRoZSBlcnJvciBmb3IgMTAgbWludXRlc1xuICAgICAgICAgIHJlc3VsdC5lcnJvciA9IGVycm9yO1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLnNldChcbiAgICAgICAgICAgIHNlc3Npb25Ub2tlbixcbiAgICAgICAgICAgIFByb21pc2UucmVzb2x2ZShyZXN1bHQpLFxuICAgICAgICAgICAgNjAgKiAxMCAqIDEwMDBcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRoaXMuYXV0aENhY2hlLmRlbChzZXNzaW9uVG9rZW4pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICB9KTtcbiAgICB0aGlzLmF1dGhDYWNoZS5zZXQoc2Vzc2lvblRva2VuLCBhdXRoUHJvbWlzZSk7XG4gICAgcmV0dXJuIGF1dGhQcm9taXNlO1xuICB9XG5cbiAgYXN5bmMgX21hdGNoZXNDTFAoXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiA/YW55LFxuICAgIG9iamVjdDogYW55LFxuICAgIGNsaWVudDogYW55LFxuICAgIHJlcXVlc3RJZDogbnVtYmVyLFxuICAgIG9wOiBzdHJpbmdcbiAgKTogYW55IHtcbiAgICAvLyB0cnkgdG8gbWF0Y2ggb24gdXNlciBmaXJzdCwgbGVzcyBleHBlbnNpdmUgdGhhbiB3aXRoIHJvbGVzXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgY29uc3QgYWNsR3JvdXAgPSBbJyonXTtcbiAgICBsZXQgdXNlcklkO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGNvbnN0IHsgdXNlcklkIH0gPSBhd2FpdCB0aGlzLmdldEF1dGhGb3JTZXNzaW9uVG9rZW4oXG4gICAgICAgIHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuXG4gICAgICApO1xuICAgICAgaWYgKHVzZXJJZCkge1xuICAgICAgICBhY2xHcm91cC5wdXNoKHVzZXJJZCk7XG4gICAgICB9XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBTY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihcbiAgICAgICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zLFxuICAgICAgICBvYmplY3QuY2xhc3NOYW1lLFxuICAgICAgICBhY2xHcm91cCxcbiAgICAgICAgb3BcbiAgICAgICk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBsb2dnZXIudmVyYm9zZShgRmFpbGVkIG1hdGNoaW5nIENMUCBmb3IgJHtvYmplY3QuaWR9ICR7dXNlcklkfSAke2V9YCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIC8vIFRPRE86IGhhbmRsZSByb2xlcyBwZXJtaXNzaW9uc1xuICAgIC8vIE9iamVjdC5rZXlzKGNsYXNzTGV2ZWxQZXJtaXNzaW9ucykuZm9yRWFjaCgoa2V5KSA9PiB7XG4gICAgLy8gICBjb25zdCBwZXJtID0gY2xhc3NMZXZlbFBlcm1pc3Npb25zW2tleV07XG4gICAgLy8gICBPYmplY3Qua2V5cyhwZXJtKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAvLyAgICAgaWYgKGtleS5pbmRleE9mKCdyb2xlJykpXG4gICAgLy8gICB9KTtcbiAgICAvLyB9KVxuICAgIC8vIC8vIGl0J3MgcmVqZWN0ZWQgaGVyZSwgY2hlY2sgdGhlIHJvbGVzXG4gICAgLy8gdmFyIHJvbGVzUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuUm9sZSk7XG4gICAgLy8gcm9sZXNRdWVyeS5lcXVhbFRvKFwidXNlcnNcIiwgdXNlcik7XG4gICAgLy8gcmV0dXJuIHJvbGVzUXVlcnkuZmluZCh7dXNlTWFzdGVyS2V5OnRydWV9KTtcbiAgfVxuXG4gIF9nZXRDTFBPcGVyYXRpb24ocXVlcnk6IGFueSkge1xuICAgIHJldHVybiB0eXBlb2YgcXVlcnkgPT09ICdvYmplY3QnICYmXG4gICAgICBPYmplY3Qua2V5cyhxdWVyeSkubGVuZ3RoID09IDEgJiZcbiAgICAgIHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZydcbiAgICAgID8gJ2dldCdcbiAgICAgIDogJ2ZpbmQnO1xuICB9XG5cbiAgYXN5bmMgX3ZlcmlmeUFDTChhY2w6IGFueSwgdG9rZW46IHN0cmluZykge1xuICAgIGlmICghdG9rZW4pIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGF1dGgsIHVzZXJJZCB9ID0gYXdhaXQgdGhpcy5nZXRBdXRoRm9yU2Vzc2lvblRva2VuKHRva2VuKTtcblxuICAgIC8vIEdldHRpbmcgdGhlIHNlc3Npb24gdG9rZW4gZmFpbGVkXG4gICAgLy8gVGhpcyBtZWFucyB0aGF0IG5vIGFkZGl0aW9uYWwgYXV0aCBpcyBhdmFpbGFibGVcbiAgICAvLyBBdCB0aGlzIHBvaW50LCBqdXN0IGJhaWwgb3V0IGFzIG5vIGFkZGl0aW9uYWwgdmlzaWJpbGl0eSBjYW4gYmUgaW5mZXJyZWQuXG4gICAgaWYgKCFhdXRoIHx8ICF1c2VySWQpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgY29uc3QgaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkID0gYWNsLmdldFJlYWRBY2Nlc3ModXNlcklkKTtcbiAgICBpZiAoaXNTdWJzY3JpcHRpb25TZXNzaW9uVG9rZW5NYXRjaGVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvLyBDaGVjayBpZiB0aGUgdXNlciBoYXMgYW55IHJvbGVzIHRoYXQgbWF0Y2ggdGhlIEFDTFxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgLnRoZW4oYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBSZXNvbHZlIGZhbHNlIHJpZ2h0IGF3YXkgaWYgdGhlIGFjbCBkb2Vzbid0IGhhdmUgYW55IHJvbGVzXG4gICAgICAgIGNvbnN0IGFjbF9oYXNfcm9sZXMgPSBPYmplY3Qua2V5cyhhY2wucGVybWlzc2lvbnNCeUlkKS5zb21lKGtleSA9PlxuICAgICAgICAgIGtleS5zdGFydHNXaXRoKCdyb2xlOicpXG4gICAgICAgICk7XG4gICAgICAgIGlmICghYWNsX2hhc19yb2xlcykge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJvbGVOYW1lcyA9IGF3YWl0IGF1dGguZ2V0VXNlclJvbGVzKCk7XG4gICAgICAgIC8vIEZpbmFsbHksIHNlZSBpZiBhbnkgb2YgdGhlIHVzZXIncyByb2xlcyBhbGxvdyB0aGVtIHJlYWQgYWNjZXNzXG4gICAgICAgIGZvciAoY29uc3Qgcm9sZSBvZiByb2xlTmFtZXMpIHtcbiAgICAgICAgICAvLyBXZSB1c2UgZ2V0UmVhZEFjY2VzcyBhcyBgcm9sZWAgaXMgaW4gdGhlIGZvcm0gYHJvbGU6cm9sZU5hbWVgXG4gICAgICAgICAgaWYgKGFjbC5nZXRSZWFkQWNjZXNzKHJvbGUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgX21hdGNoZXNBQ0woXG4gICAgYWNsOiBhbnksXG4gICAgY2xpZW50OiBhbnksXG4gICAgcmVxdWVzdElkOiBudW1iZXJcbiAgKTogUHJvbWlzZTxib29sZWFuPiB7XG4gICAgLy8gUmV0dXJuIHRydWUgZGlyZWN0bHkgaWYgQUNMIGlzbid0IHByZXNlbnQsIEFDTCBpcyBwdWJsaWMgcmVhZCwgb3IgY2xpZW50IGhhcyBtYXN0ZXIga2V5XG4gICAgaWYgKCFhY2wgfHwgYWNsLmdldFB1YmxpY1JlYWRBY2Nlc3MoKSB8fCBjbGllbnQuaGFzTWFzdGVyS2V5KSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQ2hlY2sgc3Vic2NyaXB0aW9uIHNlc3Npb25Ub2tlbiBtYXRjaGVzIEFDTCBmaXJzdFxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSBjbGllbnQuZ2V0U3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIGlmICh0eXBlb2Ygc3Vic2NyaXB0aW9uSW5mbyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJzY3JpcHRpb25Ub2tlbiA9IHN1YnNjcmlwdGlvbkluZm8uc2Vzc2lvblRva2VuO1xuICAgIGNvbnN0IGNsaWVudFNlc3Npb25Ub2tlbiA9IGNsaWVudC5zZXNzaW9uVG9rZW47XG5cbiAgICBpZiAoYXdhaXQgdGhpcy5fdmVyaWZ5QUNMKGFjbCwgc3Vic2NyaXB0aW9uVG9rZW4pKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBpZiAoYXdhaXQgdGhpcy5fdmVyaWZ5QUNMKGFjbCwgY2xpZW50U2Vzc2lvblRva2VuKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICBpZiAoIXRoaXMuX3ZhbGlkYXRlS2V5cyhyZXF1ZXN0LCB0aGlzLmtleVBhaXJzKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgNCwgJ0tleSBpbiByZXF1ZXN0IGlzIG5vdCB2YWxpZCcpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdLZXkgaW4gcmVxdWVzdCBpcyBub3QgdmFsaWQnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgaGFzTWFzdGVyS2V5ID0gdGhpcy5faGFzTWFzdGVyS2V5KHJlcXVlc3QsIHRoaXMua2V5UGFpcnMpO1xuICAgIGNvbnN0IGNsaWVudElkID0gdXVpZCgpO1xuICAgIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQoY2xpZW50SWQsIHBhcnNlV2Vic29ja2V0LCBoYXNNYXN0ZXJLZXkpO1xuICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkID0gY2xpZW50SWQ7XG4gICAgdGhpcy5jbGllbnRzLnNldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgY2xpZW50KTtcbiAgICBsb2dnZXIuaW5mbyhgQ3JlYXRlIG5ldyBjbGllbnQ6ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9YCk7XG4gICAgY2xpZW50LnB1c2hDb25uZWN0KCk7XG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ2Nvbm5lY3QnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcbiAgfVxuXG4gIF9oYXNNYXN0ZXJLZXkocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZiAoXG4gICAgICAhdmFsaWRLZXlQYWlycyB8fFxuICAgICAgdmFsaWRLZXlQYWlycy5zaXplID09IDAgfHxcbiAgICAgICF2YWxpZEtleVBhaXJzLmhhcygnbWFzdGVyS2V5JylcbiAgICApIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgaWYgKCFyZXF1ZXN0IHx8ICFyZXF1ZXN0Lmhhc093blByb3BlcnR5KCdtYXN0ZXJLZXknKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICByZXR1cm4gcmVxdWVzdC5tYXN0ZXJLZXkgPT09IHZhbGlkS2V5UGFpcnMuZ2V0KCdtYXN0ZXJLZXknKTtcbiAgfVxuXG4gIF92YWxpZGF0ZUtleXMocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZiAoIXZhbGlkS2V5UGFpcnMgfHwgdmFsaWRLZXlQYWlycy5zaXplID09IDApIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBsZXQgaXNWYWxpZCA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgW2tleSwgc2VjcmV0XSBvZiB2YWxpZEtleVBhaXJzKSB7XG4gICAgICBpZiAoIXJlcXVlc3Rba2V5XSB8fCByZXF1ZXN0W2tleV0gIT09IHNlY3JldCkge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlzVmFsaWQgPSB0cnVlO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIHJldHVybiBpc1ZhbGlkO1xuICB9XG5cbiAgX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldDogYW55LCByZXF1ZXN0OiBhbnkpOiBhbnkge1xuICAgIC8vIElmIHdlIGNhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgcmV0dXJuIGVycm9yIHRvIGNsaWVudFxuICAgIGlmICghcGFyc2VXZWJzb2NrZXQuaGFzT3duUHJvcGVydHkoJ2NsaWVudElkJykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSBzdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJ1xuICAgICAgKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG5cbiAgICAvLyBHZXQgc3Vic2NyaXB0aW9uIGZyb20gc3Vic2NyaXB0aW9ucywgY3JlYXRlIG9uZSBpZiBuZWNlc3NhcnlcbiAgICBjb25zdCBzdWJzY3JpcHRpb25IYXNoID0gcXVlcnlIYXNoKHJlcXVlc3QucXVlcnkpO1xuICAgIC8vIEFkZCBjbGFzc05hbWUgdG8gc3Vic2NyaXB0aW9ucyBpZiBuZWNlc3NhcnlcbiAgICBjb25zdCBjbGFzc05hbWUgPSByZXF1ZXN0LnF1ZXJ5LmNsYXNzTmFtZTtcbiAgICBpZiAoIXRoaXMuc3Vic2NyaXB0aW9ucy5oYXMoY2xhc3NOYW1lKSkge1xuICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLnNldChjbGFzc05hbWUsIG5ldyBNYXAoKSk7XG4gICAgfVxuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBsZXQgc3Vic2NyaXB0aW9uO1xuICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuaGFzKHN1YnNjcmlwdGlvbkhhc2gpKSB7XG4gICAgICBzdWJzY3JpcHRpb24gPSBjbGFzc1N1YnNjcmlwdGlvbnMuZ2V0KHN1YnNjcmlwdGlvbkhhc2gpO1xuICAgIH0gZWxzZSB7XG4gICAgICBzdWJzY3JpcHRpb24gPSBuZXcgU3Vic2NyaXB0aW9uKFxuICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgIHJlcXVlc3QucXVlcnkud2hlcmUsXG4gICAgICAgIHN1YnNjcmlwdGlvbkhhc2hcbiAgICAgICk7XG4gICAgICBjbGFzc1N1YnNjcmlwdGlvbnMuc2V0KHN1YnNjcmlwdGlvbkhhc2gsIHN1YnNjcmlwdGlvbik7XG4gICAgfVxuXG4gICAgLy8gQWRkIHN1YnNjcmlwdGlvbkluZm8gdG8gY2xpZW50XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IHtcbiAgICAgIHN1YnNjcmlwdGlvbjogc3Vic2NyaXB0aW9uLFxuICAgIH07XG4gICAgLy8gQWRkIHNlbGVjdGVkIGZpZWxkcyBhbmQgc2Vzc2lvblRva2VuIGZvciB0aGlzIHN1YnNjcmlwdGlvbiBpZiBuZWNlc3NhcnlcbiAgICBpZiAocmVxdWVzdC5xdWVyeS5maWVsZHMpIHtcbiAgICAgIHN1YnNjcmlwdGlvbkluZm8uZmllbGRzID0gcmVxdWVzdC5xdWVyeS5maWVsZHM7XG4gICAgfVxuICAgIGlmIChyZXF1ZXN0LnNlc3Npb25Ub2tlbikge1xuICAgICAgc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4gPSByZXF1ZXN0LnNlc3Npb25Ub2tlbjtcbiAgICB9XG4gICAgY2xpZW50LmFkZFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdC5yZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm8pO1xuXG4gICAgLy8gQWRkIGNsaWVudElkIHRvIHN1YnNjcmlwdGlvblxuICAgIHN1YnNjcmlwdGlvbi5hZGRDbGllbnRTdWJzY3JpcHRpb24oXG4gICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCxcbiAgICAgIHJlcXVlc3QucmVxdWVzdElkXG4gICAgKTtcblxuICAgIGNsaWVudC5wdXNoU3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKFxuICAgICAgYENyZWF0ZSBjbGllbnQgJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH0gbmV3IHN1YnNjcmlwdGlvbjogJHtcbiAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICAgIH1gXG4gICAgKTtcbiAgICBsb2dnZXIudmVyYm9zZSgnQ3VycmVudCBjbGllbnQgbnVtYmVyOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAnc3Vic2NyaWJlJyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgfSk7XG4gIH1cblxuICBfaGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QsIGZhbHNlKTtcbiAgICB0aGlzLl9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICB9XG5cbiAgX2hhbmRsZVVuc3Vic2NyaWJlKFxuICAgIHBhcnNlV2Vic29ja2V0OiBhbnksXG4gICAgcmVxdWVzdDogYW55LFxuICAgIG5vdGlmeUNsaWVudDogYm9vbGVhbiA9IHRydWVcbiAgKTogYW55IHtcbiAgICAvLyBJZiB3ZSBjYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIHJldHVybiBlcnJvciB0byBjbGllbnRcbiAgICBpZiAoIXBhcnNlV2Vic29ja2V0Lmhhc093blByb3BlcnR5KCdjbGllbnRJZCcpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZydcbiAgICAgICk7XG4gICAgICBsb2dnZXIuZXJyb3IoXG4gICAgICAgICdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcnXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByZXF1ZXN0SWQgPSByZXF1ZXN0LnJlcXVlc3RJZDtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmNsaWVudHMuZ2V0KHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcbiAgICBpZiAodHlwZW9mIGNsaWVudCA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IoXG4gICAgICAgIHBhcnNlV2Vic29ja2V0LFxuICAgICAgICAyLFxuICAgICAgICAnQ2Fubm90IGZpbmQgY2xpZW50IHdpdGggY2xpZW50SWQgJyArXG4gICAgICAgICAgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAgICcuIE1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nXG4gICAgICApO1xuICAgICAgbG9nZ2VyLmVycm9yKCdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQgJyArIHBhcnNlV2Vic29ja2V0LmNsaWVudElkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKFxuICAgICAgICBwYXJzZVdlYnNvY2tldCxcbiAgICAgICAgMixcbiAgICAgICAgJ0Nhbm5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgK1xuICAgICAgICAgIHBhcnNlV2Vic29ja2V0LmNsaWVudElkICtcbiAgICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgK1xuICAgICAgICAgIHJlcXVlc3RJZCArXG4gICAgICAgICAgJy4gTWFrZSBzdXJlIHlvdSBzdWJzY3JpYmUgdG8gbGl2ZSBxdWVyeSBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcuJ1xuICAgICAgKTtcbiAgICAgIGxvZ2dlci5lcnJvcihcbiAgICAgICAgJ0NhbiBub3QgZmluZCBzdWJzY3JpcHRpb24gd2l0aCBjbGllbnRJZCAnICtcbiAgICAgICAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICAgJyBzdWJzY3JpcHRpb25JZCAnICtcbiAgICAgICAgICByZXF1ZXN0SWRcbiAgICAgICk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gUmVtb3ZlIHN1YnNjcmlwdGlvbiBmcm9tIGNsaWVudFxuICAgIGNsaWVudC5kZWxldGVTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgLy8gUmVtb3ZlIGNsaWVudCBmcm9tIHN1YnNjcmlwdGlvblxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbiA9IHN1YnNjcmlwdGlvbkluZm8uc3Vic2NyaXB0aW9uO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IHN1YnNjcmlwdGlvbi5jbGFzc05hbWU7XG4gICAgc3Vic2NyaXB0aW9uLmRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbihwYXJzZVdlYnNvY2tldC5jbGllbnRJZCwgcmVxdWVzdElkKTtcbiAgICAvLyBJZiB0aGVyZSBpcyBubyBjbGllbnQgd2hpY2ggaXMgc3Vic2NyaWJpbmcgdGhpcyBzdWJzY3JpcHRpb24sIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgaWYgKCFzdWJzY3JpcHRpb24uaGFzU3Vic2NyaWJpbmdDbGllbnQoKSkge1xuICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgfVxuICAgIC8vIElmIHRoZXJlIGlzIG5vIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcywgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuc2l6ZSA9PT0gMCkge1xuICAgICAgdGhpcy5zdWJzY3JpcHRpb25zLmRlbGV0ZShjbGFzc05hbWUpO1xuICAgIH1cbiAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgIGV2ZW50OiAndW5zdWJzY3JpYmUnLFxuICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICBzdWJzY3JpcHRpb25zOiB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSxcbiAgICB9KTtcblxuICAgIGlmICghbm90aWZ5Q2xpZW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2xpZW50LnB1c2hVbnN1YnNjcmliZShyZXF1ZXN0LnJlcXVlc3RJZCk7XG5cbiAgICBsb2dnZXIudmVyYm9zZShcbiAgICAgIGBEZWxldGUgY2xpZW50OiAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfSB8IHN1YnNjcmlwdGlvbjogJHtcbiAgICAgICAgcmVxdWVzdC5yZXF1ZXN0SWRcbiAgICAgIH1gXG4gICAgKTtcbiAgfVxufVxuXG5leHBvcnQgeyBQYXJzZUxpdmVRdWVyeVNlcnZlciB9O1xuIl19