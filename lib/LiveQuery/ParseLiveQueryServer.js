'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.ParseLiveQueryServer = undefined;

var _tv = require('tv4');

var _tv2 = _interopRequireDefault(_tv);

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _Subscription = require('./Subscription');

var _Client = require('./Client');

var _ParseWebSocketServer = require('./ParseWebSocketServer');

var _logger = require('../logger');

var _logger2 = _interopRequireDefault(_logger);

var _RequestSchema = require('./RequestSchema');

var _RequestSchema2 = _interopRequireDefault(_RequestSchema);

var _QueryTools = require('./QueryTools');

var _ParsePubSub = require('./ParsePubSub');

var _SessionTokenCache = require('./SessionTokenCache');

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _uuid = require('uuid');

var _uuid2 = _interopRequireDefault(_uuid);

var _triggers = require('../triggers');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class ParseLiveQueryServer {
  // className -> (queryHash -> subscription)
  constructor(server, config) {
    this.server = server;
    this.clients = new Map();
    this.subscriptions = new Map();

    config = config || {};

    // Store keys, convert obj to map
    const keyPairs = config.keyPairs || {};
    this.keyPairs = new Map();
    for (const key of Object.keys(keyPairs)) {
      this.keyPairs.set(key, keyPairs[key]);
    }
    _logger2.default.verbose('Support key pairs', this.keyPairs);

    // Initialize Parse
    _node2.default.Object.disableSingleInstance();

    const serverURL = config.serverURL || _node2.default.serverURL;
    _node2.default.serverURL = serverURL;
    const appId = config.appId || _node2.default.applicationId;
    const javascriptKey = _node2.default.javaScriptKey;
    const masterKey = config.masterKey || _node2.default.masterKey;
    _node2.default.initialize(appId, javascriptKey, masterKey);

    // Initialize websocket server
    this.parseWebSocketServer = new _ParseWebSocketServer.ParseWebSocketServer(server, parseWebsocket => this._onConnect(parseWebsocket), config.websocketTimeout);

    // Initialize subscriber
    this.subscriber = _ParsePubSub.ParsePubSub.createSubscriber(config);
    this.subscriber.subscribe(_node2.default.applicationId + 'afterSave');
    this.subscriber.subscribe(_node2.default.applicationId + 'afterDelete');
    // Register message handler for subscriber. When publisher get messages, it will publish message
    // to the subscribers and the handler will be called.
    this.subscriber.on('message', (channel, messageStr) => {
      _logger2.default.verbose('Subscribe messsage %j', messageStr);
      let message;
      try {
        message = JSON.parse(messageStr);
      } catch (e) {
        _logger2.default.error('unable to parse message', messageStr, e);
        return;
      }
      this._inflateParseObject(message);
      if (channel === _node2.default.applicationId + 'afterSave') {
        this._onAfterSave(message);
      } else if (channel === _node2.default.applicationId + 'afterDelete') {
        this._onAfterDelete(message);
      } else {
        _logger2.default.error('Get message %s from unknown channel %j', message, channel);
      }
    });

    // Initialize sessionToken cache
    this.sessionTokenCache = new _SessionTokenCache.SessionTokenCache(config.cacheTimeout);
  }

  // Message is the JSON object from publisher. Message.currentParseObject is the ParseObject JSON after changes.
  // Message.originalParseObject is the original ParseObject JSON.

  // The subscriber we use to get object update from publisher
  _inflateParseObject(message) {
    // Inflate merged object
    const currentParseObject = message.currentParseObject;
    let className = currentParseObject.className;
    let parseObject = new _node2.default.Object(className);
    parseObject._finishFetch(currentParseObject);
    message.currentParseObject = parseObject;
    // Inflate original object
    const originalParseObject = message.originalParseObject;
    if (originalParseObject) {
      className = originalParseObject.className;
      parseObject = new _node2.default.Object(className);
      parseObject._finishFetch(originalParseObject);
      message.originalParseObject = parseObject;
    }
  }

  // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.
  _onAfterDelete(message) {
    _logger2.default.verbose(_node2.default.applicationId + 'afterDelete is triggered');

    const deletedParseObject = message.currentParseObject.toJSON();
    const className = deletedParseObject.className;
    _logger2.default.verbose('ClassName: %j | ObjectId: %s', className, deletedParseObject.id);
    _logger2.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);
    if (typeof classSubscriptions === 'undefined') {
      _logger2.default.debug('Can not find subscriptions under this class ' + className);
      return;
    }
    for (const subscription of classSubscriptions.values()) {
      const isSubscriptionMatched = this._matchesSubscription(deletedParseObject, subscription);
      if (!isSubscriptionMatched) {
        continue;
      }
      for (const [clientId, requestIds] of _lodash2.default.entries(subscription.clientRequestIds)) {
        const client = this.clients.get(clientId);
        if (typeof client === 'undefined') {
          continue;
        }
        for (const requestId of requestIds) {
          const acl = message.currentParseObject.getACL();
          // Check ACL
          this._matchesACL(acl, client, requestId).then(isMatched => {
            if (!isMatched) {
              return null;
            }
            client.pushDelete(requestId, deletedParseObject);
          }, error => {
            _logger2.default.error('Matching ACL error : ', error);
          });
        }
      }
    }
  }

  // Message is the JSON object from publisher after inflated. Message.currentParseObject is the ParseObject after changes.
  // Message.originalParseObject is the original ParseObject.
  _onAfterSave(message) {
    _logger2.default.verbose(_node2.default.applicationId + 'afterSave is triggered');

    let originalParseObject = null;
    if (message.originalParseObject) {
      originalParseObject = message.originalParseObject.toJSON();
    }
    const currentParseObject = message.currentParseObject.toJSON();
    const className = currentParseObject.className;
    _logger2.default.verbose('ClassName: %s | ObjectId: %s', className, currentParseObject.id);
    _logger2.default.verbose('Current client number : %d', this.clients.size);

    const classSubscriptions = this.subscriptions.get(className);
    if (typeof classSubscriptions === 'undefined') {
      _logger2.default.debug('Can not find subscriptions under this class ' + className);
      return;
    }
    for (const subscription of classSubscriptions.values()) {
      const isOriginalSubscriptionMatched = this._matchesSubscription(originalParseObject, subscription);
      const isCurrentSubscriptionMatched = this._matchesSubscription(currentParseObject, subscription);
      for (const [clientId, requestIds] of _lodash2.default.entries(subscription.clientRequestIds)) {
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
          }
          // Set current ParseObject ACL checking promise, if the object does not match
          // subscription, we do not need to check ACL
          let currentACLCheckingPromise;
          if (!isCurrentSubscriptionMatched) {
            currentACLCheckingPromise = Promise.resolve(false);
          } else {
            const currentACL = message.currentParseObject.getACL();
            currentACLCheckingPromise = this._matchesACL(currentACL, client, requestId);
          }

          Promise.all([originalACLCheckingPromise, currentACLCheckingPromise]).then(([isOriginalMatched, isCurrentMatched]) => {
            _logger2.default.verbose('Original %j | Current %j | Match: %s, %s, %s, %s | Query: %s', originalParseObject, currentParseObject, isOriginalSubscriptionMatched, isCurrentSubscriptionMatched, isOriginalMatched, isCurrentMatched, subscription.hash);

            // Decide event type
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
            client[functionName](requestId, currentParseObject);
          }, error => {
            _logger2.default.error('Matching ACL error : ', error);
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
          _logger2.default.error('unable to parse request', request, e);
          return;
        }
      }
      _logger2.default.verbose('Request: %j', request);

      // Check whether this request is a valid request, return error directly if not
      if (!_tv2.default.validate(request, _RequestSchema2.default['general']) || !_tv2.default.validate(request, _RequestSchema2.default[request.op])) {
        _Client.Client.pushError(parseWebsocket, 1, _tv2.default.error.message);
        _logger2.default.error('Connect message error %s', _tv2.default.error.message);
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
          _logger2.default.error('Get unknown operation', request.op);
      }
    });

    parseWebsocket.on('disconnect', () => {
      _logger2.default.info(`Client disconnect: ${parseWebsocket.clientId}`);
      const clientId = parseWebsocket.clientId;
      if (!this.clients.has(clientId)) {
        (0, _triggers.runLiveQueryEventHandlers)({
          event: 'ws_disconnect_error',
          clients: this.clients.size,
          subscriptions: this.subscriptions.size,
          error: `Unable to find client ${clientId}`
        });
        _logger2.default.error(`Can not find client ${clientId} on disconnect`);
        return;
      }

      // Delete client
      const client = this.clients.get(clientId);
      this.clients.delete(clientId);

      // Delete client from subscriptions
      for (const [requestId, subscriptionInfo] of _lodash2.default.entries(client.subscriptionInfos)) {
        const subscription = subscriptionInfo.subscription;
        subscription.deleteClientSubscription(clientId, requestId);

        // If there is no client which is subscribing this subscription, remove it from subscriptions
        const classSubscriptions = this.subscriptions.get(subscription.className);
        if (!subscription.hasSubscribingClient()) {
          classSubscriptions.delete(subscription.hash);
        }
        // If there is no subscriptions under this class, remove it from subscriptions
        if (classSubscriptions.size === 0) {
          this.subscriptions.delete(subscription.className);
        }
      }

      _logger2.default.verbose('Current clients %d', this.clients.size);
      _logger2.default.verbose('Current subscriptions %d', this.subscriptions.size);
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

  _matchesACL(acl, client, requestId) {
    // Return true directly if ACL isn't present, ACL is public read, or client has master key
    if (!acl || acl.getPublicReadAccess() || client.hasMasterKey) {
      return Promise.resolve(true);
    }
    // Check subscription sessionToken matches ACL first
    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    if (typeof subscriptionInfo === 'undefined') {
      return Promise.resolve(false);
    }

    const subscriptionSessionToken = subscriptionInfo.sessionToken;
    return this.sessionTokenCache.getUserId(subscriptionSessionToken).then(userId => {
      return acl.getReadAccess(userId);
    }).then(isSubscriptionSessionTokenMatched => {
      if (isSubscriptionSessionTokenMatched) {
        return Promise.resolve(true);
      }

      // Check if the user has any roles that match the ACL
      return new Promise((resolve, reject) => {

        // Resolve false right away if the acl doesn't have any roles
        const acl_has_roles = Object.keys(acl.permissionsById).some(key => key.startsWith("role:"));
        if (!acl_has_roles) {
          return resolve(false);
        }

        this.sessionTokenCache.getUserId(subscriptionSessionToken).then(userId => {

          // Pass along a null if there is no user id
          if (!userId) {
            return Promise.resolve(null);
          }

          // Prepare a user object to query for roles
          // To eliminate a query for the user, create one locally with the id
          var user = new _node2.default.User();
          user.id = userId;
          return user;
        }).then(user => {

          // Pass along an empty array (of roles) if no user
          if (!user) {
            return Promise.resolve([]);
          }

          // Then get the user's roles
          var rolesQuery = new _node2.default.Query(_node2.default.Role);
          rolesQuery.equalTo("users", user);
          return rolesQuery.find({ useMasterKey: true });
        }).then(roles => {

          // Finally, see if any of the user's roles allow them read access
          for (const role of roles) {
            if (acl.getRoleReadAccess(role)) {
              return resolve(true);
            }
          }
          resolve(false);
        }).catch(error => {
          reject(error);
        });
      });
    }).then(isRoleMatched => {

      if (isRoleMatched) {
        return Promise.resolve(true);
      }

      // Check client sessionToken matches ACL
      const clientSessionToken = client.sessionToken;
      return this.sessionTokenCache.getUserId(clientSessionToken).then(userId => {
        return acl.getReadAccess(userId);
      });
    }).then(isMatched => {
      return Promise.resolve(isMatched);
    }, () => {
      return Promise.resolve(false);
    });
  }

  _handleConnect(parseWebsocket, request) {
    if (!this._validateKeys(request, this.keyPairs)) {
      _Client.Client.pushError(parseWebsocket, 4, 'Key in request is not valid');
      _logger2.default.error('Key in request is not valid');
      return;
    }
    const hasMasterKey = this._hasMasterKey(request, this.keyPairs);
    const clientId = (0, _uuid2.default)();
    const client = new _Client.Client(clientId, parseWebsocket, hasMasterKey);
    parseWebsocket.clientId = clientId;
    this.clients.set(parseWebsocket.clientId, client);
    _logger2.default.info(`Create new client: ${parseWebsocket.clientId}`);
    client.pushConnect();
    (0, _triggers.runLiveQueryEventHandlers)({
      event: 'connect',
      clients: this.clients.size,
      subscriptions: this.subscriptions.size
    });
  }

  _hasMasterKey(request, validKeyPairs) {
    if (!validKeyPairs || validKeyPairs.size == 0 || !validKeyPairs.has("masterKey")) {
      return false;
    }
    if (!request || !request.hasOwnProperty("masterKey")) {
      return false;
    }
    return request.masterKey === validKeyPairs.get("masterKey");
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
      _logger2.default.error('Can not find this client, make sure you connect to server before subscribing');
      return;
    }
    const client = this.clients.get(parseWebsocket.clientId);

    // Get subscription from subscriptions, create one if necessary
    const subscriptionHash = (0, _QueryTools.queryHash)(request.query);
    // Add className to subscriptions if necessary
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
    }

    // Add subscriptionInfo to client
    const subscriptionInfo = {
      subscription: subscription
    };
    // Add selected fields and sessionToken for this subscription if necessary
    if (request.query.fields) {
      subscriptionInfo.fields = request.query.fields;
    }
    if (request.sessionToken) {
      subscriptionInfo.sessionToken = request.sessionToken;
    }
    client.addSubscriptionInfo(request.requestId, subscriptionInfo);

    // Add clientId to subscription
    subscription.addClientSubscription(parseWebsocket.clientId, request.requestId);

    client.pushSubscribe(request.requestId);

    _logger2.default.verbose(`Create client ${parseWebsocket.clientId} new subscription: ${request.requestId}`);
    _logger2.default.verbose('Current client number: %d', this.clients.size);
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
      _logger2.default.error('Can not find this client, make sure you connect to server before unsubscribing');
      return;
    }
    const requestId = request.requestId;
    const client = this.clients.get(parseWebsocket.clientId);
    if (typeof client === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find client with clientId ' + parseWebsocket.clientId + '. Make sure you connect to live query server before unsubscribing.');
      _logger2.default.error('Can not find this client ' + parseWebsocket.clientId);
      return;
    }

    const subscriptionInfo = client.getSubscriptionInfo(requestId);
    if (typeof subscriptionInfo === 'undefined') {
      _Client.Client.pushError(parseWebsocket, 2, 'Cannot find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId + '. Make sure you subscribe to live query server before unsubscribing.');
      _logger2.default.error('Can not find subscription with clientId ' + parseWebsocket.clientId + ' subscriptionId ' + requestId);
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
    if (!subscription.hasSubscribingClient()) {
      classSubscriptions.delete(subscription.hash);
    }
    // If there is no subscriptions under this class, remove it from subscriptions
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

    _logger2.default.verbose(`Delete client: ${parseWebsocket.clientId} | subscription: ${request.requestId}`);
  }
}

exports.ParseLiveQueryServer = ParseLiveQueryServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXIuanMiXSwibmFtZXMiOlsiUGFyc2VMaXZlUXVlcnlTZXJ2ZXIiLCJjb25zdHJ1Y3RvciIsInNlcnZlciIsImNvbmZpZyIsImNsaWVudHMiLCJNYXAiLCJzdWJzY3JpcHRpb25zIiwia2V5UGFpcnMiLCJrZXkiLCJPYmplY3QiLCJrZXlzIiwic2V0IiwibG9nZ2VyIiwidmVyYm9zZSIsIlBhcnNlIiwiZGlzYWJsZVNpbmdsZUluc3RhbmNlIiwic2VydmVyVVJMIiwiYXBwSWQiLCJhcHBsaWNhdGlvbklkIiwiamF2YXNjcmlwdEtleSIsImphdmFTY3JpcHRLZXkiLCJtYXN0ZXJLZXkiLCJpbml0aWFsaXplIiwicGFyc2VXZWJTb2NrZXRTZXJ2ZXIiLCJQYXJzZVdlYlNvY2tldFNlcnZlciIsInBhcnNlV2Vic29ja2V0IiwiX29uQ29ubmVjdCIsIndlYnNvY2tldFRpbWVvdXQiLCJzdWJzY3JpYmVyIiwiUGFyc2VQdWJTdWIiLCJjcmVhdGVTdWJzY3JpYmVyIiwic3Vic2NyaWJlIiwib24iLCJjaGFubmVsIiwibWVzc2FnZVN0ciIsIm1lc3NhZ2UiLCJKU09OIiwicGFyc2UiLCJlIiwiZXJyb3IiLCJfaW5mbGF0ZVBhcnNlT2JqZWN0IiwiX29uQWZ0ZXJTYXZlIiwiX29uQWZ0ZXJEZWxldGUiLCJzZXNzaW9uVG9rZW5DYWNoZSIsIlNlc3Npb25Ub2tlbkNhY2hlIiwiY2FjaGVUaW1lb3V0IiwiY3VycmVudFBhcnNlT2JqZWN0IiwiY2xhc3NOYW1lIiwicGFyc2VPYmplY3QiLCJfZmluaXNoRmV0Y2giLCJvcmlnaW5hbFBhcnNlT2JqZWN0IiwiZGVsZXRlZFBhcnNlT2JqZWN0IiwidG9KU09OIiwiaWQiLCJzaXplIiwiY2xhc3NTdWJzY3JpcHRpb25zIiwiZ2V0IiwiZGVidWciLCJzdWJzY3JpcHRpb24iLCJ2YWx1ZXMiLCJpc1N1YnNjcmlwdGlvbk1hdGNoZWQiLCJfbWF0Y2hlc1N1YnNjcmlwdGlvbiIsImNsaWVudElkIiwicmVxdWVzdElkcyIsIl8iLCJlbnRyaWVzIiwiY2xpZW50UmVxdWVzdElkcyIsImNsaWVudCIsInJlcXVlc3RJZCIsImFjbCIsImdldEFDTCIsIl9tYXRjaGVzQUNMIiwidGhlbiIsImlzTWF0Y2hlZCIsInB1c2hEZWxldGUiLCJpc09yaWdpbmFsU3Vic2NyaXB0aW9uTWF0Y2hlZCIsImlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQiLCJvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSIsIlByb21pc2UiLCJyZXNvbHZlIiwib3JpZ2luYWxBQ0wiLCJjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlIiwiY3VycmVudEFDTCIsImFsbCIsImlzT3JpZ2luYWxNYXRjaGVkIiwiaXNDdXJyZW50TWF0Y2hlZCIsImhhc2giLCJ0eXBlIiwiZnVuY3Rpb25OYW1lIiwicmVxdWVzdCIsInR2NCIsInZhbGlkYXRlIiwiUmVxdWVzdFNjaGVtYSIsIm9wIiwiQ2xpZW50IiwicHVzaEVycm9yIiwiX2hhbmRsZUNvbm5lY3QiLCJfaGFuZGxlU3Vic2NyaWJlIiwiX2hhbmRsZVVwZGF0ZVN1YnNjcmlwdGlvbiIsIl9oYW5kbGVVbnN1YnNjcmliZSIsImluZm8iLCJoYXMiLCJldmVudCIsImRlbGV0ZSIsInN1YnNjcmlwdGlvbkluZm8iLCJzdWJzY3JpcHRpb25JbmZvcyIsImRlbGV0ZUNsaWVudFN1YnNjcmlwdGlvbiIsImhhc1N1YnNjcmliaW5nQ2xpZW50IiwicXVlcnkiLCJnZXRQdWJsaWNSZWFkQWNjZXNzIiwiaGFzTWFzdGVyS2V5IiwiZ2V0U3Vic2NyaXB0aW9uSW5mbyIsInN1YnNjcmlwdGlvblNlc3Npb25Ub2tlbiIsInNlc3Npb25Ub2tlbiIsImdldFVzZXJJZCIsInVzZXJJZCIsImdldFJlYWRBY2Nlc3MiLCJpc1N1YnNjcmlwdGlvblNlc3Npb25Ub2tlbk1hdGNoZWQiLCJyZWplY3QiLCJhY2xfaGFzX3JvbGVzIiwicGVybWlzc2lvbnNCeUlkIiwic29tZSIsInN0YXJ0c1dpdGgiLCJ1c2VyIiwiVXNlciIsInJvbGVzUXVlcnkiLCJRdWVyeSIsIlJvbGUiLCJlcXVhbFRvIiwiZmluZCIsInVzZU1hc3RlcktleSIsInJvbGVzIiwicm9sZSIsImdldFJvbGVSZWFkQWNjZXNzIiwiY2F0Y2giLCJpc1JvbGVNYXRjaGVkIiwiY2xpZW50U2Vzc2lvblRva2VuIiwiX3ZhbGlkYXRlS2V5cyIsIl9oYXNNYXN0ZXJLZXkiLCJwdXNoQ29ubmVjdCIsInZhbGlkS2V5UGFpcnMiLCJoYXNPd25Qcm9wZXJ0eSIsImlzVmFsaWQiLCJzZWNyZXQiLCJzdWJzY3JpcHRpb25IYXNoIiwiU3Vic2NyaXB0aW9uIiwid2hlcmUiLCJmaWVsZHMiLCJhZGRTdWJzY3JpcHRpb25JbmZvIiwiYWRkQ2xpZW50U3Vic2NyaXB0aW9uIiwicHVzaFN1YnNjcmliZSIsIm5vdGlmeUNsaWVudCIsImRlbGV0ZVN1YnNjcmlwdGlvbkluZm8iLCJwdXNoVW5zdWJzY3JpYmUiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7QUFBQTs7OztBQUNBOzs7O0FBQ0E7O0FBQ0E7O0FBQ0E7O0FBQ0E7Ozs7QUFDQTs7OztBQUNBOztBQUNBOztBQUNBOztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7OztBQUVBLE1BQU1BLG9CQUFOLENBQTJCO0FBRXpCO0FBT0FDLGNBQVlDLE1BQVosRUFBeUJDLE1BQXpCLEVBQXNDO0FBQ3BDLFNBQUtELE1BQUwsR0FBY0EsTUFBZDtBQUNBLFNBQUtFLE9BQUwsR0FBZSxJQUFJQyxHQUFKLEVBQWY7QUFDQSxTQUFLQyxhQUFMLEdBQXFCLElBQUlELEdBQUosRUFBckI7O0FBRUFGLGFBQVNBLFVBQVUsRUFBbkI7O0FBRUE7QUFDQSxVQUFNSSxXQUFXSixPQUFPSSxRQUFQLElBQW1CLEVBQXBDO0FBQ0EsU0FBS0EsUUFBTCxHQUFnQixJQUFJRixHQUFKLEVBQWhCO0FBQ0EsU0FBSyxNQUFNRyxHQUFYLElBQWtCQyxPQUFPQyxJQUFQLENBQVlILFFBQVosQ0FBbEIsRUFBeUM7QUFDdkMsV0FBS0EsUUFBTCxD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RCxzRUFEbkM7QUFFQXhELHVCQUFPMkIsS0FBUCxDQUFhLDZDQUE2Q2QsZUFBZXFDLFFBQTVELEdBQXdFLGtCQUF4RSxHQUE2Rk0sU0FBMUc7QUFDQTtBQUNEOztBQUVEO0FBQ0FELFdBQU9xRixzQkFBUCxDQUE4QnBGLFNBQTlCO0FBQ0E7QUFDQSxVQUFNVixlQUFlOEMsaUJBQWlCOUMsWUFBdEM7QUFDQSxVQUFNWCxZQUFZVyxhQUFhWCxTQUEvQjtBQUNBVyxpQkFBYWdELHdCQUFiLENBQXNDakYsZUFBZXFDLFFBQXJELEVBQStETSxTQUEvRDtBQUNBO0FBQ0EsVUFBTWIscUJBQXFCLEtBQUtqRCxhQUFMLENBQW1Ca0QsR0FBbkIsQ0FBdUJULFNBQXZCLENBQTNCO0FBQ0EsUUFBSSxDQUFDVyxhQUFhaUQsb0JBQWIsRUFBTCxFQUEwQztBQUN4Q3BELHlCQUFtQmdELE1BQW5CLENBQTBCN0MsYUFBYTRCLElBQXZDO0FBQ0Q7QUFDRDtBQUNBLFFBQUkvQixtQkFBbUJELElBQW5CLEtBQTRCLENBQWhDLEVBQW1DO0FBQ2pDLFdBQUtoRCxhQUFMLENBQW1CaUcsTUFBbkIsQ0FBMEJ4RCxTQUExQjtBQUNEO0FBQ0QsNkNBQTBCO0FBQ3hCdUQsYUFBTyxhQURpQjtBQUV4QmxHLGVBQVMsS0FBS0EsT0FBTCxDQUFha0QsSUFGRTtBQUd4QmhELHFCQUFlLEtBQUtBLGFBQUwsQ0FBbUJnRDtBQUhWLEtBQTFCOztBQU1BLFFBQUksQ0FBQ2lHLFlBQUwsRUFBbUI7QUFDakI7QUFDRDs7QUFFRHBGLFdBQU9zRixlQUFQLENBQXVCaEUsUUFBUXJCLFNBQS9COztBQUVBeEQscUJBQU9DLE9BQVAsQ0FBZ0Isa0JBQWlCWSxlQUFlcUMsUUFBUyxvQkFBbUIyQixRQUFRckIsU0FBVSxFQUE5RjtBQUNEO0FBaGpCd0I7O1FBb2pCekJwRSxvQixHQUFBQSxvQiIsImZpbGUiOiJQYXJzZUxpdmVRdWVyeVNlcnZlci5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0djQgZnJvbSAndHY0JztcbmltcG9ydCBQYXJzZSBmcm9tICdwYXJzZS9ub2RlJztcbmltcG9ydCB7IFN1YnNjcmlwdGlvbiB9IGZyb20gJy4vU3Vic2NyaXB0aW9uJztcbmltcG9ydCB7IENsaWVudCB9IGZyb20gJy4vQ2xpZW50JztcbmltcG9ydCB7IFBhcnNlV2ViU29ja2V0U2VydmVyIH0gZnJvbSAnLi9QYXJzZVdlYlNvY2tldFNlcnZlcic7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgUmVxdWVzdFNjaGVtYSBmcm9tICcuL1JlcXVlc3RTY2hlbWEnO1xuaW1wb3J0IHsgbWF0Y2hlc1F1ZXJ5LCBxdWVyeUhhc2ggfSBmcm9tICcuL1F1ZXJ5VG9vbHMnO1xuaW1wb3J0IHsgUGFyc2VQdWJTdWIgfSBmcm9tICcuL1BhcnNlUHViU3ViJztcbmltcG9ydCB7IFNlc3Npb25Ub2tlbkNhY2hlIH0gZnJvbSAnLi9TZXNzaW9uVG9rZW5DYWNoZSc7XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuaW1wb3J0IHV1aWQgZnJvbSAndXVpZCc7XG5pbXBvcnQgeyBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzIH0gZnJvbSAnLi4vdHJpZ2dlcnMnO1xuXG5jbGFzcyBQYXJzZUxpdmVRdWVyeVNlcnZlciB7XG4gIGNsaWVudHM6IE1hcDtcbiAgLy8gY2xhc3NOYW1lIC0+IChxdWVyeUhhc2ggLT4gc3Vic2NyaXB0aW9uKVxuICBzdWJzY3JpcHRpb25zOiBPYmplY3Q7XG4gIHBhcnNlV2ViU29ja2V0U2VydmVyOiBPYmplY3Q7XG4gIGtleVBhaXJzIDogYW55O1xuICAvLyBUaGUgc3Vic2NyaWJlciB3ZSB1c2UgdG8gZ2V0IG9iamVjdCB1cGRhdGUgZnJvbSBwdWJsaXNoZXJcbiAgc3Vic2NyaWJlcjogT2JqZWN0O1xuXG4gIGNvbnN0cnVjdG9yKHNlcnZlcjogYW55LCBjb25maWc6IGFueSkge1xuICAgIHRoaXMuc2VydmVyID0gc2VydmVyO1xuICAgIHRoaXMuY2xpZW50cyA9IG5ldyBNYXAoKTtcbiAgICB0aGlzLnN1YnNjcmlwdGlvbnMgPSBuZXcgTWFwKCk7XG5cbiAgICBjb25maWcgPSBjb25maWcgfHwge307XG5cbiAgICAvLyBTdG9yZSBrZXlzLCBjb252ZXJ0IG9iaiB0byBtYXBcbiAgICBjb25zdCBrZXlQYWlycyA9IGNvbmZpZy5rZXlQYWlycyB8fCB7fTtcbiAgICB0aGlzLmtleVBhaXJzID0gbmV3IE1hcCgpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKGtleVBhaXJzKSkge1xuICAgICAgdGhpcy5rZXlQYWlycy5zZXQoa2V5LCBrZXlQYWlyc1trZXldKTtcbiAgICB9XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ1N1cHBvcnQga2V5IHBhaXJzJywgdGhpcy5rZXlQYWlycyk7XG5cbiAgICAvLyBJbml0aWFsaXplIFBhcnNlXG4gICAgUGFyc2UuT2JqZWN0LmRpc2FibGVTaW5nbGVJbnN0YW5jZSgpO1xuXG4gICAgY29uc3Qgc2VydmVyVVJMID0gY29uZmlnLnNlcnZlclVSTCB8fCBQYXJzZS5zZXJ2ZXJVUkw7XG4gICAgUGFyc2Uuc2VydmVyVVJMID0gc2VydmVyVVJMO1xuICAgIGNvbnN0IGFwcElkID0gY29uZmlnLmFwcElkIHx8IFBhcnNlLmFwcGxpY2F0aW9uSWQ7XG4gICAgY29uc3QgamF2YXNjcmlwdEtleSA9IFBhcnNlLmphdmFTY3JpcHRLZXk7XG4gICAgY29uc3QgbWFzdGVyS2V5ID0gY29uZmlnLm1hc3RlcktleSB8fCBQYXJzZS5tYXN0ZXJLZXk7XG4gICAgUGFyc2UuaW5pdGlhbGl6ZShhcHBJZCwgamF2YXNjcmlwdEtleSwgbWFzdGVyS2V5KTtcblxuICAgIC8vIEluaXRpYWxpemUgd2Vic29ja2V0IHNlcnZlclxuICAgIHRoaXMucGFyc2VXZWJTb2NrZXRTZXJ2ZXIgPSBuZXcgUGFyc2VXZWJTb2NrZXRTZXJ2ZXIoXG4gICAgICBzZXJ2ZXIsXG4gICAgICAocGFyc2VXZWJzb2NrZXQpID0+IHRoaXMuX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldCksXG4gICAgICBjb25maWcud2Vic29ja2V0VGltZW91dFxuICAgICk7XG5cbiAgICAvLyBJbml0aWFsaXplIHN1YnNjcmliZXJcbiAgICB0aGlzLnN1YnNjcmliZXIgPSBQYXJzZVB1YlN1Yi5jcmVhdGVTdWJzY3JpYmVyKGNvbmZpZyk7XG4gICAgdGhpcy5zdWJzY3JpYmVyLnN1YnNjcmliZShQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyU2F2ZScpO1xuICAgIHRoaXMuc3Vic2NyaWJlci5zdWJzY3JpYmUoUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlckRlbGV0ZScpO1xuICAgIC8vIFJlZ2lzdGVyIG1lc3NhZ2UgaGFuZGxlciBmb3Igc3Vic2NyaWJlci4gV2hlbiBwdWJsaXNoZXIgZ2V0IG1lc3NhZ2VzLCBpdCB3aWxsIHB1Ymxpc2ggbWVzc2FnZVxuICAgIC8vIHRvIHRoZSBzdWJzY3JpYmVycyBhbmQgdGhlIGhhbmRsZXIgd2lsbCBiZSBjYWxsZWQuXG4gICAgdGhpcy5zdWJzY3JpYmVyLm9uKCdtZXNzYWdlJywgKGNoYW5uZWwsIG1lc3NhZ2VTdHIpID0+IHtcbiAgICAgIGxvZ2dlci52ZXJib3NlKCdTdWJzY3JpYmUgbWVzc3NhZ2UgJWonLCBtZXNzYWdlU3RyKTtcbiAgICAgIGxldCBtZXNzYWdlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgbWVzc2FnZSA9IEpTT04ucGFyc2UobWVzc2FnZVN0cik7XG4gICAgICB9IGNhdGNoKGUpIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCd1bmFibGUgdG8gcGFyc2UgbWVzc2FnZScsIG1lc3NhZ2VTdHIsIGUpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLl9pbmZsYXRlUGFyc2VPYmplY3QobWVzc2FnZSk7XG4gICAgICBpZiAoY2hhbm5lbCA9PT0gUGFyc2UuYXBwbGljYXRpb25JZCArICdhZnRlclNhdmUnKSB7XG4gICAgICAgIHRoaXMuX29uQWZ0ZXJTYXZlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIGlmIChjaGFubmVsID09PSBQYXJzZS5hcHBsaWNhdGlvbklkICsgJ2FmdGVyRGVsZXRlJykge1xuICAgICAgICB0aGlzLl9vbkFmdGVyRGVsZXRlKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbG9nZ2VyLmVycm9yKCdHZXQgbWVzc2FnZSAlcyBmcm9tIHVua25vd24gY2hhbm5lbCAlaicsIG1lc3NhZ2UsIGNoYW5uZWwpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZXNzaW9uVG9rZW4gY2FjaGVcbiAgICB0aGlzLnNlc3Npb25Ub2tlbkNhY2hlID0gbmV3IFNlc3Npb25Ub2tlbkNhY2hlKGNvbmZpZy5jYWNoZVRpbWVvdXQpO1xuICB9XG5cbiAgLy8gTWVzc2FnZSBpcyB0aGUgSlNPTiBvYmplY3QgZnJvbSBwdWJsaXNoZXIuIE1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0IGlzIHRoZSBQYXJzZU9iamVjdCBKU09OIGFmdGVyIGNoYW5nZXMuXG4gIC8vIE1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCBpcyB0aGUgb3JpZ2luYWwgUGFyc2VPYmplY3QgSlNPTi5cbiAgX2luZmxhdGVQYXJzZU9iamVjdChtZXNzYWdlOiBhbnkpOiB2b2lkIHtcbiAgICAvLyBJbmZsYXRlIG1lcmdlZCBvYmplY3RcbiAgICBjb25zdCBjdXJyZW50UGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdDtcbiAgICBsZXQgY2xhc3NOYW1lID0gY3VycmVudFBhcnNlT2JqZWN0LmNsYXNzTmFtZTtcbiAgICBsZXQgcGFyc2VPYmplY3QgPSBuZXcgUGFyc2UuT2JqZWN0KGNsYXNzTmFtZSk7XG4gICAgcGFyc2VPYmplY3QuX2ZpbmlzaEZldGNoKGN1cnJlbnRQYXJzZU9iamVjdCk7XG4gICAgbWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QgPSBwYXJzZU9iamVjdDtcbiAgICAvLyBJbmZsYXRlIG9yaWdpbmFsIG9iamVjdFxuICAgIGNvbnN0IG9yaWdpbmFsUGFyc2VPYmplY3QgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3Q7XG4gICAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgIGNsYXNzTmFtZSA9IG9yaWdpbmFsUGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgICAgcGFyc2VPYmplY3QgPSBuZXcgUGFyc2UuT2JqZWN0KGNsYXNzTmFtZSk7XG4gICAgICBwYXJzZU9iamVjdC5fZmluaXNoRmV0Y2gob3JpZ2luYWxQYXJzZU9iamVjdCk7XG4gICAgICBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QgPSBwYXJzZU9iamVjdDtcbiAgICB9XG4gIH1cblxuICAvLyBNZXNzYWdlIGlzIHRoZSBKU09OIG9iamVjdCBmcm9tIHB1Ymxpc2hlciBhZnRlciBpbmZsYXRlZC4gTWVzc2FnZS5jdXJyZW50UGFyc2VPYmplY3QgaXMgdGhlIFBhcnNlT2JqZWN0IGFmdGVyIGNoYW5nZXMuXG4gIC8vIE1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCBpcyB0aGUgb3JpZ2luYWwgUGFyc2VPYmplY3QuXG4gIF9vbkFmdGVyRGVsZXRlKG1lc3NhZ2U6IGFueSk6IHZvaWQge1xuICAgIGxvZ2dlci52ZXJib3NlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJEZWxldGUgaXMgdHJpZ2dlcmVkJyk7XG5cbiAgICBjb25zdCBkZWxldGVkUGFyc2VPYmplY3QgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC50b0pTT04oKTtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBkZWxldGVkUGFyc2VPYmplY3QuY2xhc3NOYW1lO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDbGFzc05hbWU6ICVqIHwgT2JqZWN0SWQ6ICVzJywgY2xhc3NOYW1lLCBkZWxldGVkUGFyc2VPYmplY3QuaWQpO1xuICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IGNsaWVudCBudW1iZXIgOiAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcblxuICAgIGNvbnN0IGNsYXNzU3Vic2NyaXB0aW9ucyA9IHRoaXMuc3Vic2NyaXB0aW9ucy5nZXQoY2xhc3NOYW1lKTtcbiAgICBpZiAodHlwZW9mIGNsYXNzU3Vic2NyaXB0aW9ucyA9PT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGxvZ2dlci5kZWJ1ZygnQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbnMgdW5kZXIgdGhpcyBjbGFzcyAnICsgY2xhc3NOYW1lKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzdWJzY3JpcHRpb24gb2YgY2xhc3NTdWJzY3JpcHRpb25zLnZhbHVlcygpKSB7XG4gICAgICBjb25zdCBpc1N1YnNjcmlwdGlvbk1hdGNoZWQgPSB0aGlzLl9tYXRjaGVzU3Vic2NyaXB0aW9uKGRlbGV0ZWRQYXJzZU9iamVjdCwgc3Vic2NyaXB0aW9uKTtcbiAgICAgIGlmICghaXNTdWJzY3JpcHRpb25NYXRjaGVkKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCBbY2xpZW50SWQsIHJlcXVlc3RJZHNdIG9mIF8uZW50cmllcyhzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkcykpIHtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgcmVxdWVzdElkIG9mIHJlcXVlc3RJZHMpIHtcbiAgICAgICAgICBjb25zdCBhY2wgPSBtZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdC5nZXRBQ0woKTtcbiAgICAgICAgICAvLyBDaGVjayBBQ0xcbiAgICAgICAgICB0aGlzLl9tYXRjaGVzQUNMKGFjbCwgY2xpZW50LCByZXF1ZXN0SWQpLnRoZW4oKGlzTWF0Y2hlZCkgPT4ge1xuICAgICAgICAgICAgaWYgKCFpc01hdGNoZWQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjbGllbnQucHVzaERlbGV0ZShyZXF1ZXN0SWQsIGRlbGV0ZWRQYXJzZU9iamVjdCk7XG4gICAgICAgICAgfSwgKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBsb2dnZXIuZXJyb3IoJ01hdGNoaW5nIEFDTCBlcnJvciA6ICcsIGVycm9yKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIE1lc3NhZ2UgaXMgdGhlIEpTT04gb2JqZWN0IGZyb20gcHVibGlzaGVyIGFmdGVyIGluZmxhdGVkLiBNZXNzYWdlLmN1cnJlbnRQYXJzZU9iamVjdCBpcyB0aGUgUGFyc2VPYmplY3QgYWZ0ZXIgY2hhbmdlcy5cbiAgLy8gTWVzc2FnZS5vcmlnaW5hbFBhcnNlT2JqZWN0IGlzIHRoZSBvcmlnaW5hbCBQYXJzZU9iamVjdC5cbiAgX29uQWZ0ZXJTYXZlKG1lc3NhZ2U6IGFueSk6IHZvaWQge1xuICAgIGxvZ2dlci52ZXJib3NlKFBhcnNlLmFwcGxpY2F0aW9uSWQgKyAnYWZ0ZXJTYXZlIGlzIHRyaWdnZXJlZCcpO1xuXG4gICAgbGV0IG9yaWdpbmFsUGFyc2VPYmplY3QgPSBudWxsO1xuICAgIGlmIChtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QgPSBtZXNzYWdlLm9yaWdpbmFsUGFyc2VPYmplY3QudG9KU09OKCk7XG4gICAgfVxuICAgIGNvbnN0IGN1cnJlbnRQYXJzZU9iamVjdCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LnRvSlNPTigpO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IGN1cnJlbnRQYXJzZU9iamVjdC5jbGFzc05hbWU7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0NsYXNzTmFtZTogJXMgfCBPYmplY3RJZDogJXMnLCBjbGFzc05hbWUsIGN1cnJlbnRQYXJzZU9iamVjdC5pZCk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlciA6ICVkJywgdGhpcy5jbGllbnRzLnNpemUpO1xuXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICh0eXBlb2YgY2xhc3NTdWJzY3JpcHRpb25zID09PSAndW5kZWZpbmVkJykge1xuICAgICAgbG9nZ2VyLmRlYnVnKCdDYW4gbm90IGZpbmQgc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzICcgKyBjbGFzc05hbWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHN1YnNjcmlwdGlvbiBvZiBjbGFzc1N1YnNjcmlwdGlvbnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGlzT3JpZ2luYWxTdWJzY3JpcHRpb25NYXRjaGVkID0gdGhpcy5fbWF0Y2hlc1N1YnNjcmlwdGlvbihvcmlnaW5hbFBhcnNlT2JqZWN0LCBzdWJzY3JpcHRpb24pO1xuICAgICAgY29uc3QgaXNDdXJyZW50U3Vic2NyaXB0aW9uTWF0Y2hlZCA9IHRoaXMuX21hdGNoZXNTdWJzY3JpcHRpb24oY3VycmVudFBhcnNlT2JqZWN0LCBzdWJzY3JpcHRpb24pO1xuICAgICAgZm9yIChjb25zdCBbY2xpZW50SWQsIHJlcXVlc3RJZHNdIG9mIF8uZW50cmllcyhzdWJzY3JpcHRpb24uY2xpZW50UmVxdWVzdElkcykpIHtcbiAgICAgICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChjbGllbnRJZCk7XG4gICAgICAgIGlmICh0eXBlb2YgY2xpZW50ID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGZvciAoY29uc3QgcmVxdWVzdElkIG9mIHJlcXVlc3RJZHMpIHtcbiAgICAgICAgICAvLyBTZXQgb3JpZ25hbCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlO1xuICAgICAgICAgIGlmICghaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQpIHtcbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IG9yaWdpbmFsQUNMO1xuICAgICAgICAgICAgaWYgKG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdCkge1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTCA9IG1lc3NhZ2Uub3JpZ2luYWxQYXJzZU9iamVjdC5nZXRBQ0woKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9yaWdpbmFsQUNMQ2hlY2tpbmdQcm9taXNlID0gdGhpcy5fbWF0Y2hlc0FDTChvcmlnaW5hbEFDTCwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBTZXQgY3VycmVudCBQYXJzZU9iamVjdCBBQ0wgY2hlY2tpbmcgcHJvbWlzZSwgaWYgdGhlIG9iamVjdCBkb2VzIG5vdCBtYXRjaFxuICAgICAgICAgIC8vIHN1YnNjcmlwdGlvbiwgd2UgZG8gbm90IG5lZWQgdG8gY2hlY2sgQUNMXG4gICAgICAgICAgbGV0IGN1cnJlbnRBQ0xDaGVja2luZ1Byb21pc2U7XG4gICAgICAgICAgaWYgKCFpc0N1cnJlbnRTdWJzY3JpcHRpb25NYXRjaGVkKSB7XG4gICAgICAgICAgICBjdXJyZW50QUNMQ2hlY2tpbmdQcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgY3VycmVudEFDTCA9IG1lc3NhZ2UuY3VycmVudFBhcnNlT2JqZWN0LmdldEFDTCgpO1xuICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZSA9IHRoaXMuX21hdGNoZXNBQ0woY3VycmVudEFDTCwgY2xpZW50LCByZXF1ZXN0SWQpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIFByb21pc2UuYWxsKFxuICAgICAgICAgICAgW1xuICAgICAgICAgICAgICBvcmlnaW5hbEFDTENoZWNraW5nUHJvbWlzZSxcbiAgICAgICAgICAgICAgY3VycmVudEFDTENoZWNraW5nUHJvbWlzZVxuICAgICAgICAgICAgXVxuICAgICAgICAgICkudGhlbigoW2lzT3JpZ2luYWxNYXRjaGVkLCBpc0N1cnJlbnRNYXRjaGVkXSkgPT4ge1xuICAgICAgICAgICAgbG9nZ2VyLnZlcmJvc2UoJ09yaWdpbmFsICVqIHwgQ3VycmVudCAlaiB8IE1hdGNoOiAlcywgJXMsICVzLCAlcyB8IFF1ZXJ5OiAlcycsXG4gICAgICAgICAgICAgIG9yaWdpbmFsUGFyc2VPYmplY3QsXG4gICAgICAgICAgICAgIGN1cnJlbnRQYXJzZU9iamVjdCxcbiAgICAgICAgICAgICAgaXNPcmlnaW5hbFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgIGlzQ3VycmVudFN1YnNjcmlwdGlvbk1hdGNoZWQsXG4gICAgICAgICAgICAgIGlzT3JpZ2luYWxNYXRjaGVkLFxuICAgICAgICAgICAgICBpc0N1cnJlbnRNYXRjaGVkLFxuICAgICAgICAgICAgICBzdWJzY3JpcHRpb24uaGFzaFxuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgLy8gRGVjaWRlIGV2ZW50IHR5cGVcbiAgICAgICAgICAgIGxldCB0eXBlO1xuICAgICAgICAgICAgaWYgKGlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgdHlwZSA9ICdVcGRhdGUnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpc09yaWdpbmFsTWF0Y2hlZCAmJiAhaXNDdXJyZW50TWF0Y2hlZCkge1xuICAgICAgICAgICAgICB0eXBlID0gJ0xlYXZlJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWlzT3JpZ2luYWxNYXRjaGVkICYmIGlzQ3VycmVudE1hdGNoZWQpIHtcbiAgICAgICAgICAgICAgaWYgKG9yaWdpbmFsUGFyc2VPYmplY3QpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gJ0VudGVyJztcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gJ0NyZWF0ZSc7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25OYW1lID0gJ3B1c2gnICsgdHlwZTtcbiAgICAgICAgICAgIGNsaWVudFtmdW5jdGlvbk5hbWVdKHJlcXVlc3RJZCwgY3VycmVudFBhcnNlT2JqZWN0KTtcbiAgICAgICAgICB9LCAoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGxvZ2dlci5lcnJvcignTWF0Y2hpbmcgQUNMIGVycm9yIDogJywgZXJyb3IpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgX29uQ29ubmVjdChwYXJzZVdlYnNvY2tldDogYW55KTogdm9pZCB7XG4gICAgcGFyc2VXZWJzb2NrZXQub24oJ21lc3NhZ2UnLCAocmVxdWVzdCkgPT4ge1xuICAgICAgaWYgKHR5cGVvZiByZXF1ZXN0ID09PSAnc3RyaW5nJykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlcXVlc3QgPSBKU09OLnBhcnNlKHJlcXVlc3QpO1xuICAgICAgICB9IGNhdGNoKGUpIHtcbiAgICAgICAgICBsb2dnZXIuZXJyb3IoJ3VuYWJsZSB0byBwYXJzZSByZXF1ZXN0JywgcmVxdWVzdCwgZSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBsb2dnZXIudmVyYm9zZSgnUmVxdWVzdDogJWonLCByZXF1ZXN0KTtcblxuICAgICAgLy8gQ2hlY2sgd2hldGhlciB0aGlzIHJlcXVlc3QgaXMgYSB2YWxpZCByZXF1ZXN0LCByZXR1cm4gZXJyb3IgZGlyZWN0bHkgaWYgbm90XG4gICAgICBpZiAoIXR2NC52YWxpZGF0ZShyZXF1ZXN0LCBSZXF1ZXN0U2NoZW1hWydnZW5lcmFsJ10pIHx8ICF0djQudmFsaWRhdGUocmVxdWVzdCwgUmVxdWVzdFNjaGVtYVtyZXF1ZXN0Lm9wXSkpIHtcbiAgICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMSwgdHY0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgICBsb2dnZXIuZXJyb3IoJ0Nvbm5lY3QgbWVzc2FnZSBlcnJvciAlcycsIHR2NC5lcnJvci5tZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzd2l0Y2gocmVxdWVzdC5vcCkge1xuICAgICAgY2FzZSAnY29ubmVjdCc6XG4gICAgICAgIHRoaXMuX2hhbmRsZUNvbm5lY3QocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ3N1YnNjcmliZSc6XG4gICAgICAgIHRoaXMuX2hhbmRsZVN1YnNjcmliZShwYXJzZVdlYnNvY2tldCwgcmVxdWVzdCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAndXBkYXRlJzpcbiAgICAgICAgdGhpcy5faGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICd1bnN1YnNjcmliZSc6XG4gICAgICAgIHRoaXMuX2hhbmRsZVVuc3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0LCByZXF1ZXN0KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAzLCAnR2V0IHVua25vd24gb3BlcmF0aW9uJyk7XG4gICAgICAgIGxvZ2dlci5lcnJvcignR2V0IHVua25vd24gb3BlcmF0aW9uJywgcmVxdWVzdC5vcCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBwYXJzZVdlYnNvY2tldC5vbignZGlzY29ubmVjdCcsICgpID0+IHtcbiAgICAgIGxvZ2dlci5pbmZvKGBDbGllbnQgZGlzY29ubmVjdDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH1gKTtcbiAgICAgIGNvbnN0IGNsaWVudElkID0gcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQ7XG4gICAgICBpZiAoIXRoaXMuY2xpZW50cy5oYXMoY2xpZW50SWQpKSB7XG4gICAgICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgICAgIGV2ZW50OiAnd3NfZGlzY29ubmVjdF9lcnJvcicsXG4gICAgICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemUsXG4gICAgICAgICAgZXJyb3I6IGBVbmFibGUgdG8gZmluZCBjbGllbnQgJHtjbGllbnRJZH1gXG4gICAgICAgIH0pO1xuICAgICAgICBsb2dnZXIuZXJyb3IoYENhbiBub3QgZmluZCBjbGllbnQgJHtjbGllbnRJZH0gb24gZGlzY29ubmVjdGApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnRcbiAgICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQoY2xpZW50SWQpO1xuICAgICAgdGhpcy5jbGllbnRzLmRlbGV0ZShjbGllbnRJZCk7XG5cbiAgICAgIC8vIERlbGV0ZSBjbGllbnQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICBmb3IgKGNvbnN0IFtyZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm9dIG9mIF8uZW50cmllcyhjbGllbnQuc3Vic2NyaXB0aW9uSW5mb3MpKSB7XG4gICAgICAgIGNvbnN0IHN1YnNjcmlwdGlvbiA9IHN1YnNjcmlwdGlvbkluZm8uc3Vic2NyaXB0aW9uO1xuICAgICAgICBzdWJzY3JpcHRpb24uZGVsZXRlQ2xpZW50U3Vic2NyaXB0aW9uKGNsaWVudElkLCByZXF1ZXN0SWQpO1xuXG4gICAgICAgIC8vIElmIHRoZXJlIGlzIG5vIGNsaWVudCB3aGljaCBpcyBzdWJzY3JpYmluZyB0aGlzIHN1YnNjcmlwdGlvbiwgcmVtb3ZlIGl0IGZyb20gc3Vic2NyaXB0aW9uc1xuICAgICAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KHN1YnNjcmlwdGlvbi5jbGFzc05hbWUpO1xuICAgICAgICBpZiAoIXN1YnNjcmlwdGlvbi5oYXNTdWJzY3JpYmluZ0NsaWVudCgpKSB7XG4gICAgICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLmRlbGV0ZShzdWJzY3JpcHRpb24uaGFzaCk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gSWYgdGhlcmUgaXMgbm8gc3Vic2NyaXB0aW9ucyB1bmRlciB0aGlzIGNsYXNzLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgICAgIGlmIChjbGFzc1N1YnNjcmlwdGlvbnMuc2l6ZSA9PT0gMCkge1xuICAgICAgICAgIHRoaXMuc3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmNsYXNzTmFtZSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50cyAlZCcsIHRoaXMuY2xpZW50cy5zaXplKTtcbiAgICAgIGxvZ2dlci52ZXJib3NlKCdDdXJyZW50IHN1YnNjcmlwdGlvbnMgJWQnLCB0aGlzLnN1YnNjcmlwdGlvbnMuc2l6ZSk7XG4gICAgICBydW5MaXZlUXVlcnlFdmVudEhhbmRsZXJzKHtcbiAgICAgICAgZXZlbnQ6ICd3c19kaXNjb25uZWN0JyxcbiAgICAgICAgY2xpZW50czogdGhpcy5jbGllbnRzLnNpemUsXG4gICAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplXG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICd3c19jb25uZWN0JyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemVcbiAgICB9KTtcbiAgfVxuXG4gIF9tYXRjaGVzU3Vic2NyaXB0aW9uKHBhcnNlT2JqZWN0OiBhbnksIHN1YnNjcmlwdGlvbjogYW55KTogYm9vbGVhbiB7XG4gICAgLy8gT2JqZWN0IGlzIHVuZGVmaW5lZCBvciBudWxsLCBub3QgbWF0Y2hcbiAgICBpZiAoIXBhcnNlT2JqZWN0KSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiBtYXRjaGVzUXVlcnkocGFyc2VPYmplY3QsIHN1YnNjcmlwdGlvbi5xdWVyeSk7XG4gIH1cblxuICBfbWF0Y2hlc0FDTChhY2w6IGFueSwgY2xpZW50OiBhbnksIHJlcXVlc3RJZDogbnVtYmVyKTogYW55IHtcbiAgICAvLyBSZXR1cm4gdHJ1ZSBkaXJlY3RseSBpZiBBQ0wgaXNuJ3QgcHJlc2VudCwgQUNMIGlzIHB1YmxpYyByZWFkLCBvciBjbGllbnQgaGFzIG1hc3RlciBrZXlcbiAgICBpZiAoIWFjbCB8fCBhY2wuZ2V0UHVibGljUmVhZEFjY2VzcygpIHx8IGNsaWVudC5oYXNNYXN0ZXJLZXkpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJ1ZSk7XG4gICAgfVxuICAgIC8vIENoZWNrIHN1YnNjcmlwdGlvbiBzZXNzaW9uVG9rZW4gbWF0Y2hlcyBBQ0wgZmlyc3RcbiAgICBjb25zdCBzdWJzY3JpcHRpb25JbmZvID0gY2xpZW50LmdldFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdElkKTtcbiAgICBpZiAodHlwZW9mIHN1YnNjcmlwdGlvbkluZm8gPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdWJzY3JpcHRpb25TZXNzaW9uVG9rZW4gPSBzdWJzY3JpcHRpb25JbmZvLnNlc3Npb25Ub2tlbjtcbiAgICByZXR1cm4gdGhpcy5zZXNzaW9uVG9rZW5DYWNoZS5nZXRVc2VySWQoc3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuKS50aGVuKCh1c2VySWQpID0+IHtcbiAgICAgIHJldHVybiBhY2wuZ2V0UmVhZEFjY2Vzcyh1c2VySWQpO1xuICAgIH0pLnRoZW4oKGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCkgPT4ge1xuICAgICAgaWYgKGlzU3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuTWF0Y2hlZCkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRydWUpO1xuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBpZiB0aGUgdXNlciBoYXMgYW55IHJvbGVzIHRoYXQgbWF0Y2ggdGhlIEFDTFxuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgICAgICAvLyBSZXNvbHZlIGZhbHNlIHJpZ2h0IGF3YXkgaWYgdGhlIGFjbCBkb2Vzbid0IGhhdmUgYW55IHJvbGVzXG4gICAgICAgIGNvbnN0IGFjbF9oYXNfcm9sZXMgPSBPYmplY3Qua2V5cyhhY2wucGVybWlzc2lvbnNCeUlkKS5zb21lKGtleSA9PiBrZXkuc3RhcnRzV2l0aChcInJvbGU6XCIpKTtcbiAgICAgICAgaWYgKCFhY2xfaGFzX3JvbGVzKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5zZXNzaW9uVG9rZW5DYWNoZS5nZXRVc2VySWQoc3Vic2NyaXB0aW9uU2Vzc2lvblRva2VuKVxuICAgICAgICAgIC50aGVuKCh1c2VySWQpID0+IHtcblxuICAgICAgICAgICAgLy8gUGFzcyBhbG9uZyBhIG51bGwgaWYgdGhlcmUgaXMgbm8gdXNlciBpZFxuICAgICAgICAgICAgaWYgKCF1c2VySWQpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShudWxsKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gUHJlcGFyZSBhIHVzZXIgb2JqZWN0IHRvIHF1ZXJ5IGZvciByb2xlc1xuICAgICAgICAgICAgLy8gVG8gZWxpbWluYXRlIGEgcXVlcnkgZm9yIHRoZSB1c2VyLCBjcmVhdGUgb25lIGxvY2FsbHkgd2l0aCB0aGUgaWRcbiAgICAgICAgICAgIHZhciB1c2VyID0gbmV3IFBhcnNlLlVzZXIoKTtcbiAgICAgICAgICAgIHVzZXIuaWQgPSB1c2VySWQ7XG4gICAgICAgICAgICByZXR1cm4gdXNlcjtcblxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4oKHVzZXIpID0+IHtcblxuICAgICAgICAgICAgLy8gUGFzcyBhbG9uZyBhbiBlbXB0eSBhcnJheSAob2Ygcm9sZXMpIGlmIG5vIHVzZXJcbiAgICAgICAgICAgIGlmICghdXNlcikge1xuICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKFtdKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gVGhlbiBnZXQgdGhlIHVzZXIncyByb2xlc1xuICAgICAgICAgICAgdmFyIHJvbGVzUXVlcnkgPSBuZXcgUGFyc2UuUXVlcnkoUGFyc2UuUm9sZSk7XG4gICAgICAgICAgICByb2xlc1F1ZXJ5LmVxdWFsVG8oXCJ1c2Vyc1wiLCB1c2VyKTtcbiAgICAgICAgICAgIHJldHVybiByb2xlc1F1ZXJ5LmZpbmQoe3VzZU1hc3RlcktleTp0cnVlfSk7XG4gICAgICAgICAgfSkuXG4gICAgICAgICAgdGhlbigocm9sZXMpID0+IHtcblxuICAgICAgICAgICAgLy8gRmluYWxseSwgc2VlIGlmIGFueSBvZiB0aGUgdXNlcidzIHJvbGVzIGFsbG93IHRoZW0gcmVhZCBhY2Nlc3NcbiAgICAgICAgICAgIGZvciAoY29uc3Qgcm9sZSBvZiByb2xlcykge1xuICAgICAgICAgICAgICBpZiAoYWNsLmdldFJvbGVSZWFkQWNjZXNzKHJvbGUpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc29sdmUodHJ1ZSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc29sdmUoZmFsc2UpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgICAgcmVqZWN0KGVycm9yKTtcbiAgICAgICAgICB9KTtcblxuICAgICAgfSk7XG4gICAgfSkudGhlbigoaXNSb2xlTWF0Y2hlZCkgPT4ge1xuXG4gICAgICBpZihpc1JvbGVNYXRjaGVkKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUodHJ1ZSk7XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGNsaWVudCBzZXNzaW9uVG9rZW4gbWF0Y2hlcyBBQ0xcbiAgICAgIGNvbnN0IGNsaWVudFNlc3Npb25Ub2tlbiA9IGNsaWVudC5zZXNzaW9uVG9rZW47XG4gICAgICByZXR1cm4gdGhpcy5zZXNzaW9uVG9rZW5DYWNoZS5nZXRVc2VySWQoY2xpZW50U2Vzc2lvblRva2VuKS50aGVuKCh1c2VySWQpID0+IHtcbiAgICAgICAgcmV0dXJuIGFjbC5nZXRSZWFkQWNjZXNzKHVzZXJJZCk7XG4gICAgICB9KTtcbiAgICB9KS50aGVuKChpc01hdGNoZWQpID0+IHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoaXNNYXRjaGVkKTtcbiAgICB9LCAoKSA9PiB7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKGZhbHNlKTtcbiAgICB9KTtcbiAgfVxuXG4gIF9oYW5kbGVDb25uZWN0KHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgaWYgKCF0aGlzLl92YWxpZGF0ZUtleXMocmVxdWVzdCwgdGhpcy5rZXlQYWlycykpIHtcbiAgICAgIENsaWVudC5wdXNoRXJyb3IocGFyc2VXZWJzb2NrZXQsIDQsICdLZXkgaW4gcmVxdWVzdCBpcyBub3QgdmFsaWQnKTtcbiAgICAgIGxvZ2dlci5lcnJvcignS2V5IGluIHJlcXVlc3QgaXMgbm90IHZhbGlkJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGhhc01hc3RlcktleSA9IHRoaXMuX2hhc01hc3RlcktleShyZXF1ZXN0LCB0aGlzLmtleVBhaXJzKTtcbiAgICBjb25zdCBjbGllbnRJZCA9IHV1aWQoKTtcbiAgICBjb25zdCBjbGllbnQgPSBuZXcgQ2xpZW50KGNsaWVudElkLCBwYXJzZVdlYnNvY2tldCwgaGFzTWFzdGVyS2V5KTtcbiAgICBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCA9IGNsaWVudElkO1xuICAgIHRoaXMuY2xpZW50cy5zZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIGNsaWVudCk7XG4gICAgbG9nZ2VyLmluZm8oYENyZWF0ZSBuZXcgY2xpZW50OiAke3BhcnNlV2Vic29ja2V0LmNsaWVudElkfWApO1xuICAgIGNsaWVudC5wdXNoQ29ubmVjdCgpO1xuICAgIHJ1bkxpdmVRdWVyeUV2ZW50SGFuZGxlcnMoe1xuICAgICAgZXZlbnQ6ICdjb25uZWN0JyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemVcbiAgICB9KTtcbiAgfVxuXG4gIF9oYXNNYXN0ZXJLZXkocmVxdWVzdDogYW55LCB2YWxpZEtleVBhaXJzOiBhbnkpOiBib29sZWFuIHtcbiAgICBpZighdmFsaWRLZXlQYWlycyB8fCB2YWxpZEtleVBhaXJzLnNpemUgPT0gMCB8fFxuICAgICAgIXZhbGlkS2V5UGFpcnMuaGFzKFwibWFzdGVyS2V5XCIpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGlmKCFyZXF1ZXN0IHx8ICFyZXF1ZXN0Lmhhc093blByb3BlcnR5KFwibWFzdGVyS2V5XCIpKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIHJldHVybiByZXF1ZXN0Lm1hc3RlcktleSA9PT0gdmFsaWRLZXlQYWlycy5nZXQoXCJtYXN0ZXJLZXlcIik7XG4gIH1cblxuICBfdmFsaWRhdGVLZXlzKHJlcXVlc3Q6IGFueSwgdmFsaWRLZXlQYWlyczogYW55KTogYm9vbGVhbiB7XG4gICAgaWYgKCF2YWxpZEtleVBhaXJzIHx8IHZhbGlkS2V5UGFpcnMuc2l6ZSA9PSAwKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgbGV0IGlzVmFsaWQgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIHNlY3JldF0gb2YgdmFsaWRLZXlQYWlycykge1xuICAgICAgaWYgKCFyZXF1ZXN0W2tleV0gfHwgcmVxdWVzdFtrZXldICE9PSBzZWNyZXQpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpc1ZhbGlkID0gdHJ1ZTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICByZXR1cm4gaXNWYWxpZDtcbiAgfVxuXG4gIF9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQ6IGFueSwgcmVxdWVzdDogYW55KTogYW55IHtcbiAgICAvLyBJZiB3ZSBjYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIHJldHVybiBlcnJvciB0byBjbGllbnRcbiAgICBpZiAoIXBhcnNlV2Vic29ja2V0Lmhhc093blByb3BlcnR5KCdjbGllbnRJZCcpKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAyLCAnQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCBtYWtlIHN1cmUgeW91IGNvbm5lY3QgdG8gc2VydmVyIGJlZm9yZSBzdWJzY3JpYmluZycpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHN1YnNjcmliaW5nJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuY2xpZW50cy5nZXQocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQpO1xuXG4gICAgLy8gR2V0IHN1YnNjcmlwdGlvbiBmcm9tIHN1YnNjcmlwdGlvbnMsIGNyZWF0ZSBvbmUgaWYgbmVjZXNzYXJ5XG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSGFzaCA9IHF1ZXJ5SGFzaChyZXF1ZXN0LnF1ZXJ5KTtcbiAgICAvLyBBZGQgY2xhc3NOYW1lIHRvIHN1YnNjcmlwdGlvbnMgaWYgbmVjZXNzYXJ5XG4gICAgY29uc3QgY2xhc3NOYW1lID0gcmVxdWVzdC5xdWVyeS5jbGFzc05hbWU7XG4gICAgaWYgKCF0aGlzLnN1YnNjcmlwdGlvbnMuaGFzKGNsYXNzTmFtZSkpIHtcbiAgICAgIHRoaXMuc3Vic2NyaXB0aW9ucy5zZXQoY2xhc3NOYW1lLCBuZXcgTWFwKCkpO1xuICAgIH1cbiAgICBjb25zdCBjbGFzc1N1YnNjcmlwdGlvbnMgPSB0aGlzLnN1YnNjcmlwdGlvbnMuZ2V0KGNsYXNzTmFtZSk7XG4gICAgbGV0IHN1YnNjcmlwdGlvbjtcbiAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLmhhcyhzdWJzY3JpcHRpb25IYXNoKSkge1xuICAgICAgc3Vic2NyaXB0aW9uID0gY2xhc3NTdWJzY3JpcHRpb25zLmdldChzdWJzY3JpcHRpb25IYXNoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3Vic2NyaXB0aW9uID0gbmV3IFN1YnNjcmlwdGlvbihjbGFzc05hbWUsIHJlcXVlc3QucXVlcnkud2hlcmUsIHN1YnNjcmlwdGlvbkhhc2gpO1xuICAgICAgY2xhc3NTdWJzY3JpcHRpb25zLnNldChzdWJzY3JpcHRpb25IYXNoLCBzdWJzY3JpcHRpb24pO1xuICAgIH1cblxuICAgIC8vIEFkZCBzdWJzY3JpcHRpb25JbmZvIHRvIGNsaWVudFxuICAgIGNvbnN0IHN1YnNjcmlwdGlvbkluZm8gPSB7XG4gICAgICBzdWJzY3JpcHRpb246IHN1YnNjcmlwdGlvblxuICAgIH07XG4gICAgLy8gQWRkIHNlbGVjdGVkIGZpZWxkcyBhbmQgc2Vzc2lvblRva2VuIGZvciB0aGlzIHN1YnNjcmlwdGlvbiBpZiBuZWNlc3NhcnlcbiAgICBpZiAocmVxdWVzdC5xdWVyeS5maWVsZHMpIHtcbiAgICAgIHN1YnNjcmlwdGlvbkluZm8uZmllbGRzID0gcmVxdWVzdC5xdWVyeS5maWVsZHM7XG4gICAgfVxuICAgIGlmIChyZXF1ZXN0LnNlc3Npb25Ub2tlbikge1xuICAgICAgc3Vic2NyaXB0aW9uSW5mby5zZXNzaW9uVG9rZW4gPSByZXF1ZXN0LnNlc3Npb25Ub2tlbjtcbiAgICB9XG4gICAgY2xpZW50LmFkZFN1YnNjcmlwdGlvbkluZm8ocmVxdWVzdC5yZXF1ZXN0SWQsIHN1YnNjcmlwdGlvbkluZm8pO1xuXG4gICAgLy8gQWRkIGNsaWVudElkIHRvIHN1YnNjcmlwdGlvblxuICAgIHN1YnNjcmlwdGlvbi5hZGRDbGllbnRTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGNsaWVudC5wdXNoU3Vic2NyaWJlKHJlcXVlc3QucmVxdWVzdElkKTtcblxuICAgIGxvZ2dlci52ZXJib3NlKGBDcmVhdGUgY2xpZW50ICR7cGFyc2VXZWJzb2NrZXQuY2xpZW50SWR9IG5ldyBzdWJzY3JpcHRpb246ICR7cmVxdWVzdC5yZXF1ZXN0SWR9YCk7XG4gICAgbG9nZ2VyLnZlcmJvc2UoJ0N1cnJlbnQgY2xpZW50IG51bWJlcjogJWQnLCB0aGlzLmNsaWVudHMuc2l6ZSk7XG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ3N1YnNjcmliZScsXG4gICAgICBjbGllbnRzOiB0aGlzLmNsaWVudHMuc2l6ZSxcbiAgICAgIHN1YnNjcmlwdGlvbnM6IHRoaXMuc3Vic2NyaXB0aW9ucy5zaXplXG4gICAgfSk7XG4gIH1cblxuICBfaGFuZGxlVXBkYXRlU3Vic2NyaXB0aW9uKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSk6IGFueSB7XG4gICAgdGhpcy5faGFuZGxlVW5zdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QsIGZhbHNlKTtcbiAgICB0aGlzLl9oYW5kbGVTdWJzY3JpYmUocGFyc2VXZWJzb2NrZXQsIHJlcXVlc3QpO1xuICB9XG5cbiAgX2hhbmRsZVVuc3Vic2NyaWJlKHBhcnNlV2Vic29ja2V0OiBhbnksIHJlcXVlc3Q6IGFueSwgbm90aWZ5Q2xpZW50OiBib29sID0gdHJ1ZSk6IGFueSB7XG4gICAgLy8gSWYgd2UgY2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50LCByZXR1cm4gZXJyb3IgdG8gY2xpZW50XG4gICAgaWYgKCFwYXJzZVdlYnNvY2tldC5oYXNPd25Qcm9wZXJ0eSgnY2xpZW50SWQnKSkge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMiwgJ0NhbiBub3QgZmluZCB0aGlzIGNsaWVudCwgbWFrZSBzdXJlIHlvdSBjb25uZWN0IHRvIHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZycpO1xuICAgICAgbG9nZ2VyLmVycm9yKCdDYW4gbm90IGZpbmQgdGhpcyBjbGllbnQsIG1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBzZXJ2ZXIgYmVmb3JlIHVuc3Vic2NyaWJpbmcnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcmVxdWVzdElkID0gcmVxdWVzdC5yZXF1ZXN0SWQ7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5jbGllbnRzLmdldChwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG4gICAgaWYgKHR5cGVvZiBjbGllbnQgPT09ICd1bmRlZmluZWQnKSB7XG4gICAgICBDbGllbnQucHVzaEVycm9yKHBhcnNlV2Vic29ja2V0LCAyLCAnQ2Fubm90IGZpbmQgY2xpZW50IHdpdGggY2xpZW50SWQgJyAgKyBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArXG4gICAgICAgICcuIE1ha2Ugc3VyZSB5b3UgY29ubmVjdCB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nKTtcbiAgICAgIGxvZ2dlci5lcnJvcignQ2FuIG5vdCBmaW5kIHRoaXMgY2xpZW50ICcgKyBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc3Vic2NyaXB0aW9uSW5mbyA9IGNsaWVudC5nZXRTdWJzY3JpcHRpb25JbmZvKHJlcXVlc3RJZCk7XG4gICAgaWYgKHR5cGVvZiBzdWJzY3JpcHRpb25JbmZvID09PSAndW5kZWZpbmVkJykge1xuICAgICAgQ2xpZW50LnB1c2hFcnJvcihwYXJzZVdlYnNvY2tldCwgMiwgJ0Nhbm5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgICsgcGFyc2VXZWJzb2NrZXQuY2xpZW50SWQgK1xuICAgICAgICAnIHN1YnNjcmlwdGlvbklkICcgKyByZXF1ZXN0SWQgKyAnLiBNYWtlIHN1cmUgeW91IHN1YnNjcmliZSB0byBsaXZlIHF1ZXJ5IHNlcnZlciBiZWZvcmUgdW5zdWJzY3JpYmluZy4nKTtcbiAgICAgIGxvZ2dlci5lcnJvcignQ2FuIG5vdCBmaW5kIHN1YnNjcmlwdGlvbiB3aXRoIGNsaWVudElkICcgKyBwYXJzZVdlYnNvY2tldC5jbGllbnRJZCArICAnIHN1YnNjcmlwdGlvbklkICcgKyByZXF1ZXN0SWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFJlbW92ZSBzdWJzY3JpcHRpb24gZnJvbSBjbGllbnRcbiAgICBjbGllbnQuZGVsZXRlU3Vic2NyaXB0aW9uSW5mbyhyZXF1ZXN0SWQpO1xuICAgIC8vIFJlbW92ZSBjbGllbnQgZnJvbSBzdWJzY3JpcHRpb25cbiAgICBjb25zdCBzdWJzY3JpcHRpb24gPSBzdWJzY3JpcHRpb25JbmZvLnN1YnNjcmlwdGlvbjtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBzdWJzY3JpcHRpb24uY2xhc3NOYW1lO1xuICAgIHN1YnNjcmlwdGlvbi5kZWxldGVDbGllbnRTdWJzY3JpcHRpb24ocGFyc2VXZWJzb2NrZXQuY2xpZW50SWQsIHJlcXVlc3RJZCk7XG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gY2xpZW50IHdoaWNoIGlzIHN1YnNjcmliaW5nIHRoaXMgc3Vic2NyaXB0aW9uLCByZW1vdmUgaXQgZnJvbSBzdWJzY3JpcHRpb25zXG4gICAgY29uc3QgY2xhc3NTdWJzY3JpcHRpb25zID0gdGhpcy5zdWJzY3JpcHRpb25zLmdldChjbGFzc05hbWUpO1xuICAgIGlmICghc3Vic2NyaXB0aW9uLmhhc1N1YnNjcmliaW5nQ2xpZW50KCkpIHtcbiAgICAgIGNsYXNzU3Vic2NyaXB0aW9ucy5kZWxldGUoc3Vic2NyaXB0aW9uLmhhc2gpO1xuICAgIH1cbiAgICAvLyBJZiB0aGVyZSBpcyBubyBzdWJzY3JpcHRpb25zIHVuZGVyIHRoaXMgY2xhc3MsIHJlbW92ZSBpdCBmcm9tIHN1YnNjcmlwdGlvbnNcbiAgICBpZiAoY2xhc3NTdWJzY3JpcHRpb25zLnNpemUgPT09IDApIHtcbiAgICAgIHRoaXMuc3Vic2NyaXB0aW9ucy5kZWxldGUoY2xhc3NOYW1lKTtcbiAgICB9XG4gICAgcnVuTGl2ZVF1ZXJ5RXZlbnRIYW5kbGVycyh7XG4gICAgICBldmVudDogJ3Vuc3Vic2NyaWJlJyxcbiAgICAgIGNsaWVudHM6IHRoaXMuY2xpZW50cy5zaXplLFxuICAgICAgc3Vic2NyaXB0aW9uczogdGhpcy5zdWJzY3JpcHRpb25zLnNpemVcbiAgICB9KTtcblxuICAgIGlmICghbm90aWZ5Q2xpZW50KSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY2xpZW50LnB1c2hVbnN1YnNjcmliZShyZXF1ZXN0LnJlcXVlc3RJZCk7XG5cbiAgICBsb2dnZXIudmVyYm9zZShgRGVsZXRlIGNsaWVudDogJHtwYXJzZVdlYnNvY2tldC5jbGllbnRJZH0gfCBzdWJzY3JpcHRpb246ICR7cmVxdWVzdC5yZXF1ZXN0SWR9YCk7XG4gIH1cbn1cblxuZXhwb3J0IHtcbiAgUGFyc2VMaXZlUXVlcnlTZXJ2ZXJcbn1cbiJdfQ==