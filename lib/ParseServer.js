"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _Options = require("./Options");

var _defaults = _interopRequireDefault(require("./defaults"));

var logging = _interopRequireWildcard(require("./logger"));

var _Config = _interopRequireDefault(require("./Config"));

var _PromiseRouter = _interopRequireDefault(require("./PromiseRouter"));

var _requiredParameter = _interopRequireDefault(require("./requiredParameter"));

var _AnalyticsRouter = require("./Routers/AnalyticsRouter");

var _ClassesRouter = require("./Routers/ClassesRouter");

var _FeaturesRouter = require("./Routers/FeaturesRouter");

var _FilesRouter = require("./Routers/FilesRouter");

var _FunctionsRouter = require("./Routers/FunctionsRouter");

var _GlobalConfigRouter = require("./Routers/GlobalConfigRouter");

var _HooksRouter = require("./Routers/HooksRouter");

var _IAPValidationRouter = require("./Routers/IAPValidationRouter");

var _InstallationsRouter = require("./Routers/InstallationsRouter");

var _LogsRouter = require("./Routers/LogsRouter");

var _ParseLiveQueryServer = require("./LiveQuery/ParseLiveQueryServer");

var _PublicAPIRouter = require("./Routers/PublicAPIRouter");

var _PushRouter = require("./Routers/PushRouter");

var _CloudCodeRouter = require("./Routers/CloudCodeRouter");

var _RolesRouter = require("./Routers/RolesRouter");

var _SchemasRouter = require("./Routers/SchemasRouter");

var _SessionsRouter = require("./Routers/SessionsRouter");

var _UsersRouter = require("./Routers/UsersRouter");

var _PurgeRouter = require("./Routers/PurgeRouter");

var _AudiencesRouter = require("./Routers/AudiencesRouter");

var _AggregateRouter = require("./Routers/AggregateRouter");

var _ParseServerRESTController = require("./ParseServerRESTController");

var controllers = _interopRequireWildcard(require("./Controllers"));

var _ParseGraphQLServer = require("./GraphQL/ParseGraphQLServer");

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = Object.defineProperty && Object.getOwnPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : {}; if (desc.get || desc.set) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// ParseServer - open-source compatible API Server for Parse apps
var batch = require('./batch'),
    bodyParser = require('body-parser'),
    express = require('express'),
    middlewares = require('./middlewares'),
    Parse = require('parse/node').Parse,
    path = require('path');

// Mutate the Parse object to add the Cloud Code handlers
addParseCloud(); // ParseServer works like a constructor of an express app.
// The args that we understand are:
// "analyticsAdapter": an adapter class for analytics
// "filesAdapter": a class like GridFSBucketAdapter providing create, get,
//                 and delete
// "loggerAdapter": a class like WinstonLoggerAdapter providing info, error,
//                 and query
// "jsonLogs": log as structured JSON objects
// "databaseURI": a uri like mongodb://localhost:27017/dbname to tell us
//          what database this Parse API connects to.
// "cloud": relative location to cloud code to require, or a function
//          that is given an instance of Parse as a parameter.  Use this instance of Parse
//          to register your cloud code hooks and functions.
// "appId": the application id to host
// "masterKey": the master key for requests to this app
// "collectionPrefix": optional prefix for database collection names
// "fileKey": optional key from Parse dashboard for supporting older files
//            hosted by Parse
// "clientKey": optional key from Parse dashboard
// "dotNetKey": optional key from Parse dashboard
// "restAPIKey": optional key from Parse dashboard
// "webhookKey": optional key from Parse dashboard
// "javascriptKey": optional key from Parse dashboard
// "push": optional key from configure push
// "sessionLength": optional length in seconds for how long Sessions should be valid for
// "maxLimit": optional upper bound for what can be specified for the 'limit' parameter on queries

class ParseServer {
  /**
   * @constructor
   * @param {ParseServerOptions} options the parse server initialization options
   */
  constructor(options) {
    injectDefaults(options);
    const {
      appId = (0, _requiredParameter.default)('You must provide an appId!'),
      masterKey = (0, _requiredParameter.default)('You must provide a masterKey!'),
      cloud,
      javascriptKey,
      serverURL = (0, _requiredParameter.default)('You must provide a serverURL!'),
      serverStartComplete
    } = options; // Initialize the node client SDK automatically

    Parse.initialize(appId, javascriptKey || 'unused', masterKey);
    Parse.serverURL = serverURL;
    const allControllers = controllers.getControllers(options);
    const {
      loggerController,
      databaseController,
      hooksController
    } = allControllers;
    this.config = _Config.default.put(Object.assign({}, options, allControllers));
    logging.setLogger(loggerController);
    const dbInitPromise = databaseController.performInitialization();
    const hooksLoadPromise = hooksController.load(); // Note: Tests will start to fail if any validation happens after this is called.

    Promise.all([dbInitPromise, hooksLoadPromise]).then(() => {
      if (serverStartComplete) {
        serverStartComplete();
      }
    }).catch(error => {
      if (serverStartComplete) {
        serverStartComplete(error);
      } else {
        // eslint-disable-next-line no-console
        console.error(error);
        process.exit(1);
      }
    });

    if (cloud) {
      addParseCloud();

      if (typeof cloud === 'function') {
        cloud(Parse);
      } else if (typeof cloud === 'string') {
        require(path.resolve(process.cwd(), cloud));
      } else {
        throw "argument 'cloud' must either be a string or a function";
      }
    }
  }

  get app() {
    if (!this._app) {
      this._app = ParseServer.app(this.config);
    }

    return this._app;
  }

  handleShutdown() {
    const {
      adapter
    } = this.config.databaseController;

    if (adapter && typeof adapter.handleShutdown === 'function') {
      adapter.handleShutdown();
    }
  }
  /**
   * @static
   * Create an express app for the parse server
   * @param {Object} options let you specify the maxUploadSize when creating the express app  */


  static app({
    maxUploadSize = '20mb',
    appId,
    directAccess
  }) {
    // This app serves the Parse API directly.
    // It's the equivalent of https://api.parse.com/1 in the hosted Parse API.
    var api = express(); //api.use("/apps", express.static(__dirname + "/public"));

    api.use(middlewares.allowCrossDomain); // File handling needs to be before default middlewares are applied

    api.use('/', new _FilesRouter.FilesRouter().expressRouter({
      maxUploadSize: maxUploadSize
    }));
    api.use('/health', function (req, res) {
      res.json({
        status: 'ok'
      });
    });
    api.use('/', bodyParser.urlencoded({
      extended: false
    }), new _PublicAPIRouter.PublicAPIRouter().expressRouter());
    api.use(bodyParser.json({
      type: '*/*',
      limit: maxUploadSize
    }));
    api.use(middlewares.allowMethodOverride);
    api.use(middlewares.handleParseHeaders);
    const appRouter = ParseServer.promiseRouter({
      appId
    });
    api.use(appRouter.expressRouter());
    api.use(middlewares.handleParseErrors); // run the following when not testing

    if (!process.env.TESTING) {
      //This causes tests to spew some useless warnings, so disable in test

      /* istanbul ignore next */
      process.on('uncaughtException', err => {
        if (err.code === 'EADDRINUSE') {
          // user-friendly message for this common error
          process.stderr.write(`Unable to listen on port ${err.port}. The port is already in use.`);
          process.exit(0);
        } else {
          throw err;
        }
      }); // verify the server url after a 'mount' event is received

      /* istanbul ignore next */

      api.on('mount', function () {
        ParseServer.verifyServerUrl();
      });
    }

    if (process.env.PARSE_SERVER_ENABLE_EXPERIMENTAL_DIRECT_ACCESS === '1' || directAccess) {
      Parse.CoreManager.setRESTController((0, _ParseServerRESTController.ParseServerRESTController)(appId, appRouter));
    }

    return api;
  }

  static promiseRouter({
    appId
  }) {
    const routers = [new _ClassesRouter.ClassesRouter(), new _UsersRouter.UsersRouter(), new _SessionsRouter.SessionsRouter(), new _RolesRouter.RolesRouter(), new _AnalyticsRouter.AnalyticsRouter(), new _InstallationsRouter.InstallationsRouter(), new _FunctionsRouter.FunctionsRouter(), new _SchemasRouter.SchemasRouter(), new _PushRouter.PushRouter(), new _LogsRouter.LogsRouter(), new _IAPValidationRouter.IAPValidationRouter(), new _FeaturesRouter.FeaturesRouter(), new _GlobalConfigRouter.GlobalConfigRouter(), new _PurgeRouter.PurgeRouter(), new _HooksRouter.HooksRouter(), new _CloudCodeRouter.CloudCodeRouter(), new _AudiencesRouter.AudiencesRouter(), new _AggregateRouter.AggregateRouter()];
    const routes = routers.reduce((memo, router) => {
      return memo.concat(router.routes);
    }, []);
    const appRouter = new _PromiseRouter.default(routes, appId);
    batch.mountOnto(appRouter);
    return appRouter;
  }
  /**
   * starts the parse server's express app
   * @param {ParseServerOptions} options to use to start the server
   * @param {Function} callback called when the server has started
   * @returns {ParseServer} the parse server instance
   */


  start(options, callback) {
    const app = express();

    if (options.middleware) {
      let middleware;

      if (typeof options.middleware == 'string') {
        middleware = require(path.resolve(process.cwd(), options.middleware));
      } else {
        middleware = options.middleware; // use as-is let express fail
      }

      app.use(middleware);
    }

    app.use(options.mountPath, this.app);

    if (options.mountGraphQL === true || options.mountPlayground === true) {
      const parseGraphQLServer = new _ParseGraphQLServer.ParseGraphQLServer(this, {
        graphQLPath: options.graphQLPath,
        playgroundPath: options.playgroundPath
      });

      if (options.mountGraphQL) {
        parseGraphQLServer.applyGraphQL(app);
      }

      if (options.mountPlayground) {
        parseGraphQLServer.applyPlayground(app);
      }
    }

    const server = app.listen(options.port, options.host, callback);
    this.server = server;

    if (options.startLiveQueryServer || options.liveQueryServerOptions) {
      this.liveQueryServer = ParseServer.createLiveQueryServer(server, options.liveQueryServerOptions);
    }
    /* istanbul ignore next */


    if (!process.env.TESTING) {
      configureListeners(this);
    }

    this.expressApp = app;
    return this;
  }
  /**
   * Creates a new ParseServer and starts it.
   * @param {ParseServerOptions} options used to start the server
   * @param {Function} callback called when the server has started
   * @returns {ParseServer} the parse server instance
   */


  static start(options, callback) {
    const parseServer = new ParseServer(options);
    return parseServer.start(options, callback);
  }
  /**
   * Helper method to create a liveQuery server
   * @static
   * @param {Server} httpServer an optional http server to pass
   * @param {LiveQueryServerOptions} config options fot he liveQueryServer
   * @returns {ParseLiveQueryServer} the live query server instance
   */


  static createLiveQueryServer(httpServer, config) {
    if (!httpServer || config && config.port) {
      var app = express();
      httpServer = require('http').createServer(app);
      httpServer.listen(config.port);
    }

    return new _ParseLiveQueryServer.ParseLiveQueryServer(httpServer, config);
  }

  static verifyServerUrl(callback) {
    // perform a health check on the serverURL value
    if (Parse.serverURL) {
      const request = require('./request');

      request({
        url: Parse.serverURL.replace(/\/$/, '') + '/health'
      }).catch(response => response).then(response => {
        const json = response.data || null;

        if (response.status !== 200 || !json || json && json.status !== 'ok') {
          /* eslint-disable no-console */
          console.warn(`\nWARNING, Unable to connect to '${Parse.serverURL}'.` + ` Cloud code and push notifications may be unavailable!\n`);
          /* eslint-enable no-console */

          if (callback) {
            callback(false);
          }
        } else {
          if (callback) {
            callback(true);
          }
        }
      });
    }
  }

}

function addParseCloud() {
  const ParseCloud = require('./cloud-code/Parse.Cloud');

  Object.assign(Parse.Cloud, ParseCloud);
  global.Parse = Parse;
}

function injectDefaults(options) {
  Object.keys(_defaults.default).forEach(key => {
    if (!options.hasOwnProperty(key)) {
      options[key] = _defaults.default[key];
    }
  });

  if (!options.hasOwnProperty('serverURL')) {
    options.serverURL = `http://localhost:${options.port}${options.mountPath}`;
  } // Backwards compatibility


  if (options.userSensitiveFields) {
    /* eslint-disable no-console */
    !process.env.TESTING && console.warn(`\nDEPRECATED: userSensitiveFields has been replaced by protectedFields allowing the ability to protect fields in all classes with CLP. \n`);
    /* eslint-enable no-console */

    const userSensitiveFields = Array.from(new Set([...(_defaults.default.userSensitiveFields || []), ...(options.userSensitiveFields || [])])); // If the options.protectedFields is unset,
    // it'll be assigned the default above.
    // Here, protect against the case where protectedFields
    // is set, but doesn't have _User.

    if (!('_User' in options.protectedFields)) {
      options.protectedFields = Object.assign({
        _User: []
      }, options.protectedFields);
    }

    options.protectedFields['_User']['*'] = Array.from(new Set([...(options.protectedFields['_User']['*'] || []), ...userSensitiveFields]));
  } // Merge protectedFields options with defaults.


  Object.keys(_defaults.default.protectedFields).forEach(c => {
    const cur = options.protectedFields[c];

    if (!cur) {
      options.protectedFields[c] = _defaults.default.protectedFields[c];
    } else {
      Object.keys(_defaults.default.protectedFields[c]).forEach(r => {
        const unq = new Set([...(options.protectedFields[c][r] || []), ..._defaults.default.protectedFields[c][r]]);
        options.protectedFields[c][r] = Array.from(unq);
      });
    }
  });
  options.masterKeyIps = Array.from(new Set(options.masterKeyIps.concat(_defaults.default.masterKeyIps, options.masterKeyIps)));
} // Those can't be tested as it requires a subprocess

/* istanbul ignore next */


function configureListeners(parseServer) {
  const server = parseServer.server;
  const sockets = {};
  /* Currently, express doesn't shut down immediately after receiving SIGINT/SIGTERM if it has client connections that haven't timed out. (This is a known issue with node - https://github.com/nodejs/node/issues/2642)
    This function, along with `destroyAliveConnections()`, intend to fix this behavior such that parse server will close all open connections and initiate the shutdown process as soon as it receives a SIGINT/SIGTERM signal. */

  server.on('connection', socket => {
    const socketId = socket.remoteAddress + ':' + socket.remotePort;
    sockets[socketId] = socket;
    socket.on('close', () => {
      delete sockets[socketId];
    });
  });

  const destroyAliveConnections = function () {
    for (const socketId in sockets) {
      try {
        sockets[socketId].destroy();
      } catch (e) {
        /* */
      }
    }
  };

  const handleShutdown = function () {
    process.stdout.write('Termination signal received. Shutting down.');
    destroyAliveConnections();
    server.close();
    parseServer.handleShutdown();
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

var _default = ParseServer;
exports.default = _default;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9QYXJzZVNlcnZlci5qcyJdLCJuYW1lcyI6WyJiYXRjaCIsInJlcXVpcmUiLCJib2R5UGFyc2VyIiwiZXhwcmVzcyIsIm1pZGRsZXdhcmVzIiwiUGFyc2UiLCJwYXRoIiwiYWRkUGFyc2VDbG91ZCIsIlBhcnNlU2VydmVyIiwiY29uc3RydWN0b3IiLCJvcHRpb25zIiwiaW5qZWN0RGVmYXVsdHMiLCJhcHBJZCIsIm1hc3RlcktleSIsImNsb3VkIiwiamF2YXNjcmlwdEtleSIsInNlcnZlclVSTCIsInNlcnZlclN0YXJ0Q29tcGxldGUiLCJpbml0aWFsaXplIiwiYWxsQ29udHJvbGxlcnMiLCJjb250cm9sbGVycyIsImdldENvbnRyb2xsZXJzIiwibG9nZ2VyQ29udHJvbGxlciIsImRhdGFiYXNlQ29udHJvbGxlciIsImhvb2tzQ29udHJvbGxlciIsImNvbmZpZyIsIkNvbmZpZyIsInB1dCIsIk9iamVjdCIsImFzc2lnbiIsImxvZ2dpbmciLCJzZXRMb2dnZXIiLCJkYkluaXRQcm9taXNlIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwiaG9va3NMb2FkUHJvbWlzZSIsImxvYWQiLCJQcm9taXNlIiwiYWxsIiwidGhlbiIsImNhdGNoIiwiZXJyb3IiLCJjb25zb2xlIiwicHJvY2VzcyIsImV4aXQiLCJyZXNvbHZlIiwiY3dkIiwiYXBwIiwiX2FwcCIsImhhbmRsZVNodXRkb3duIiwiYWRhcHRlciIsIm1heFVwbG9hZFNpemUiLCJkaXJlY3RBY2Nlc3MiLCJhcGkiLCJ1c2UiLCJhbGxvd0Nyb3NzRG9tYWluIiwiRmlsZXNSb3V0ZXIiLCJleHByZXNzUm91dGVyIiwicmVxIiwicmVzIiwianNvbiIsInN0YXR1cyIsInVybGVuY29kZWQiLCJleHRlbmRlZCIsIlB1YmxpY0FQSVJvdXRlciIsInR5cGUiLCJsaW1pdCIsImFsbG93TWV0aG9kT3ZlcnJpZGUiLCJoYW5kbGVQYXJzZUhlYWRlcnMiLCJhcHBSb3V0ZXIiLCJwcm9taXNlUm91dGVyIiwiaGFuZGxlUGFyc2VFcnJvcnMiLCJlbnYiLCJURVNUSU5HIiwib24iLCJlcnIiLCJjb2RlIiwic3RkZXJyIiwid3JpdGUiLCJwb3J0IiwidmVyaWZ5U2VydmVyVXJsIiwiUEFSU0VfU0VSVkVSX0VOQUJMRV9FWFBFUklNRU5UQUxfRElSRUNUX0FDQ0VTUyIsIkNvcmVNYW5hZ2VyIiwic2V0UkVTVENvbnRyb2xsZXIiLCJyb3V0ZXJzIiwiQ2xhc3Nlc1JvdXRlciIsIlVzZXJzUm91dGVyIiwiU2Vzc2lvbnNSb3V0ZXIiLCJSb2xlc1JvdXRlciIsIkFuYWx5dGljc1JvdXRlciIsIkluc3RhbGxhdGlvbnNSb3V0ZXIiLCJGdW5jdGlvbnNSb3V0ZXIiLCJTY2hlbWFzUm91dGVyIiwiUHVzaFJvdXRlciIsIkxvZ3NSb3V0ZXIiLCJJQVBWYWxpZGF0aW9uUm91dGVyIiwiRmVhdHVyZXNSb3V0ZXIiLCJHbG9iYWxDb25maWdSb3V0ZXIiLCJQdXJnZVJvdXRlciIsIkhvb2tzUm91dGVyIiwiQ2xvdWRDb2RlUm91dGVyIiwiQXVkaWVuY2VzUm91dGVyIiwiQWdncmVnYXRlUm91dGVyIiwicm91dGVzIiwicmVkdWNlIiwibWVtbyIsInJvdXRlciIsImNvbmNhdCIsIlByb21pc2VSb3V0ZXIiLCJtb3VudE9udG8iLCJzdGFydCIsImNhbGxiYWNrIiwibWlkZGxld2FyZSIsIm1vdW50UGF0aCIsIm1vdW50R3JhcGhRTCIsIm1vdW50UGxheWdyb3VuZCIsInBhcnNlR3JhcGhRTFNlcnZlciIsIlBhcnNlR3JhcGhRTFNlcnZlciIsImdyYXBoUUxQYXRoIiwicGxheWdyb3VuZFBhdGgiLCJhcHBseUdyYXBoUUwiLCJhcHBseVBsYXlncm91bmQiLCJzZXJ2ZXIiLCJsaXN0ZW4iLCJob3N0Iiwic3RhcnRMaXZlUXVlcnlTZXJ2ZXIiLCJsaXZlUXVlcnlTZXJ2ZXJPcHRpb25zIiwibGl2ZVF1ZXJ5U2VydmVyIiwiY3JlYXRlTGl2ZVF1ZXJ5U2VydmVyIiwiY29uZmlndXJlTGlzdGVuZXJzIiwiZXhwcmVzc0FwcCIsInBhcnNlU2VydmVyIiwiaHR0cFNlcnZlciIsImNyZWF0ZVNlcnZlciIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwicmVxdWVzdCIsInVybCIsInJlcGxhY2UiLCJyZXNwb25zZSIsImRhdGEiLCJ3YXJuIiwiUGFyc2VDbG91ZCIsIkNsb3VkIiwiZ2xvYmFsIiwia2V5cyIsImRlZmF1bHRzIiwiZm9yRWFjaCIsImtleSIsImhhc093blByb3BlcnR5IiwidXNlclNlbnNpdGl2ZUZpZWxkcyIsIkFycmF5IiwiZnJvbSIsIlNldCIsInByb3RlY3RlZEZpZWxkcyIsIl9Vc2VyIiwiYyIsImN1ciIsInIiLCJ1bnEiLCJtYXN0ZXJLZXlJcHMiLCJzb2NrZXRzIiwic29ja2V0Iiwic29ja2V0SWQiLCJyZW1vdGVBZGRyZXNzIiwicmVtb3RlUG9ydCIsImRlc3Ryb3lBbGl2ZUNvbm5lY3Rpb25zIiwiZGVzdHJveSIsImUiLCJzdGRvdXQiLCJjbG9zZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7OztBQVNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOztBQUNBOzs7Ozs7QUF0Q0E7QUFFQSxJQUFJQSxLQUFLLEdBQUdDLE9BQU8sQ0FBQyxTQUFELENBQW5CO0FBQUEsSUFDRUMsVUFBVSxHQUFHRCxPQUFPLENBQUMsYUFBRCxDQUR0QjtBQUFBLElBRUVFLE9BQU8sR0FBR0YsT0FBTyxDQUFDLFNBQUQsQ0FGbkI7QUFBQSxJQUdFRyxXQUFXLEdBQUdILE9BQU8sQ0FBQyxlQUFELENBSHZCO0FBQUEsSUFJRUksS0FBSyxHQUFHSixPQUFPLENBQUMsWUFBRCxDQUFQLENBQXNCSSxLQUpoQztBQUFBLElBS0VDLElBQUksR0FBR0wsT0FBTyxDQUFDLE1BQUQsQ0FMaEI7O0FBc0NBO0FBQ0FN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QUNBdUYsSUFBQUEsdUJBQXVCO0FBQ3ZCM0MsSUFBQUEsTUFBTSxDQUFDK0MsS0FBUDtBQUNBdEMsSUFBQUEsV0FBVyxDQUFDbEYsY0FBWjtBQUNELEdBTEQ7O0FBTUFOLEVBQUFBLE9BQU8sQ0FBQytCLEVBQVIsQ0FBVyxTQUFYLEVBQXNCekIsY0FBdEI7QUFDQU4sRUFBQUEsT0FBTyxDQUFDK0IsRUFBUixDQUFXLFFBQVgsRUFBcUJ6QixjQUFyQjtBQUNEOztlQUVjeEMsVyIsInNvdXJjZXNDb250ZW50IjpbIi8vIFBhcnNlU2VydmVyIC0gb3Blbi1zb3VyY2UgY29tcGF0aWJsZSBBUEkgU2VydmVyIGZvciBQYXJzZSBhcHBzXG5cbnZhciBiYXRjaCA9IHJlcXVpcmUoJy4vYmF0Y2gnKSxcbiAgYm9keVBhcnNlciA9IHJlcXVpcmUoJ2JvZHktcGFyc2VyJyksXG4gIGV4cHJlc3MgPSByZXF1aXJlKCdleHByZXNzJyksXG4gIG1pZGRsZXdhcmVzID0gcmVxdWlyZSgnLi9taWRkbGV3YXJlcycpLFxuICBQYXJzZSA9IHJlcXVpcmUoJ3BhcnNlL25vZGUnKS5QYXJzZSxcbiAgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuaW1wb3J0IHsgUGFyc2VTZXJ2ZXJPcHRpb25zLCBMaXZlUXVlcnlTZXJ2ZXJPcHRpb25zIH0gZnJvbSAnLi9PcHRpb25zJztcbmltcG9ydCBkZWZhdWx0cyBmcm9tICcuL2RlZmF1bHRzJztcbmltcG9ydCAqIGFzIGxvZ2dpbmcgZnJvbSAnLi9sb2dnZXInO1xuaW1wb3J0IENvbmZpZyBmcm9tICcuL0NvbmZpZyc7XG5pbXBvcnQgUHJvbWlzZVJvdXRlciBmcm9tICcuL1Byb21pc2VSb3V0ZXInO1xuaW1wb3J0IHJlcXVpcmVkUGFyYW1ldGVyIGZyb20gJy4vcmVxdWlyZWRQYXJhbWV0ZXInO1xuaW1wb3J0IHsgQW5hbHl0aWNzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0FuYWx5dGljc1JvdXRlcic7XG5pbXBvcnQgeyBDbGFzc2VzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0NsYXNzZXNSb3V0ZXInO1xuaW1wb3J0IHsgRmVhdHVyZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvRmVhdHVyZXNSb3V0ZXInO1xuaW1wb3J0IHsgRmlsZXNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvRmlsZXNSb3V0ZXInO1xuaW1wb3J0IHsgRnVuY3Rpb25zUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0Z1bmN0aW9uc1JvdXRlcic7XG5pbXBvcnQgeyBHbG9iYWxDb25maWdSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvR2xvYmFsQ29uZmlnUm91dGVyJztcbmltcG9ydCB7IEhvb2tzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0hvb2tzUm91dGVyJztcbmltcG9ydCB7IElBUFZhbGlkYXRpb25Sb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvSUFQVmFsaWRhdGlvblJvdXRlcic7XG5pbXBvcnQgeyBJbnN0YWxsYXRpb25zUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0luc3RhbGxhdGlvbnNSb3V0ZXInO1xuaW1wb3J0IHsgTG9nc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9Mb2dzUm91dGVyJztcbmltcG9ydCB7IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyIH0gZnJvbSAnLi9MaXZlUXVlcnkvUGFyc2VMaXZlUXVlcnlTZXJ2ZXInO1xuaW1wb3J0IHsgUHVibGljQVBJUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1B1YmxpY0FQSVJvdXRlcic7XG5pbXBvcnQgeyBQdXNoUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1B1c2hSb3V0ZXInO1xuaW1wb3J0IHsgQ2xvdWRDb2RlUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0Nsb3VkQ29kZVJvdXRlcic7XG5pbXBvcnQgeyBSb2xlc1JvdXRlciB9IGZyb20gJy4vUm91dGVycy9Sb2xlc1JvdXRlcic7XG5pbXBvcnQgeyBTY2hlbWFzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL1NjaGVtYXNSb3V0ZXInO1xuaW1wb3J0IHsgU2Vzc2lvbnNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvU2Vzc2lvbnNSb3V0ZXInO1xuaW1wb3J0IHsgVXNlcnNSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvVXNlcnNSb3V0ZXInO1xuaW1wb3J0IHsgUHVyZ2VSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvUHVyZ2VSb3V0ZXInO1xuaW1wb3J0IHsgQXVkaWVuY2VzUm91dGVyIH0gZnJvbSAnLi9Sb3V0ZXJzL0F1ZGllbmNlc1JvdXRlcic7XG5pbXBvcnQgeyBBZ2dyZWdhdGVSb3V0ZXIgfSBmcm9tICcuL1JvdXRlcnMvQWdncmVnYXRlUm91dGVyJztcbmltcG9ydCB7IFBhcnNlU2VydmVyUkVTVENvbnRyb2xsZXIgfSBmcm9tICcuL1BhcnNlU2VydmVyUkVTVENvbnRyb2xsZXInO1xuaW1wb3J0ICogYXMgY29udHJvbGxlcnMgZnJvbSAnLi9Db250cm9sbGVycyc7XG5pbXBvcnQgeyBQYXJzZUdyYXBoUUxTZXJ2ZXIgfSBmcm9tICcuL0dyYXBoUUwvUGFyc2VHcmFwaFFMU2VydmVyJztcblxuLy8gTXV0YXRlIHRoZSBQYXJzZSBvYmplY3QgdG8gYWRkIHRoZSBDbG91ZCBDb2RlIGhhbmRsZXJzXG5hZGRQYXJzZUNsb3VkKCk7XG5cbi8vIFBhcnNlU2VydmVyIHdvcmtzIGxpa2UgYSBjb25zdHJ1Y3RvciBvZiBhbiBleHByZXNzIGFwcC5cbi8vIFRoZSBhcmdzIHRoYXQgd2UgdW5kZXJzdGFuZCBhcmU6XG4vLyBcImFuYWx5dGljc0FkYXB0ZXJcIjogYW4gYWRhcHRlciBjbGFzcyBmb3IgYW5hbHl0aWNzXG4vLyBcImZpbGVzQWRhcHRlclwiOiBhIGNsYXNzIGxpa2UgR3JpZEZTQnVja2V0QWRhcHRlciBwcm92aWRpbmcgY3JlYXRlLCBnZXQsXG4vLyAgICAgICAgICAgICAgICAgYW5kIGRlbGV0ZVxuLy8gXCJsb2dnZXJBZGFwdGVyXCI6IGEgY2xhc3MgbGlrZSBXaW5zdG9uTG9nZ2VyQWRhcHRlciBwcm92aWRpbmcgaW5mbywgZXJyb3IsXG4vLyAgICAgICAgICAgICAgICAgYW5kIHF1ZXJ5XG4vLyBcImpzb25Mb2dzXCI6IGxvZyBhcyBzdHJ1Y3R1cmVkIEpTT04gb2JqZWN0c1xuLy8gXCJkYXRhYmFzZVVSSVwiOiBhIHVyaSBsaWtlIG1vbmdvZGI6Ly9sb2NhbGhvc3Q6MjcwMTcvZGJuYW1lIHRvIHRlbGwgdXNcbi8vICAgICAgICAgIHdoYXQgZGF0YWJhc2UgdGhpcyBQYXJzZSBBUEkgY29ubmVjdHMgdG8uXG4vLyBcImNsb3VkXCI6IHJlbGF0aXZlIGxvY2F0aW9uIHRvIGNsb3VkIGNvZGUgdG8gcmVxdWlyZSwgb3IgYSBmdW5jdGlvblxuLy8gICAgICAgICAgdGhhdCBpcyBnaXZlbiBhbiBpbnN0YW5jZSBvZiBQYXJzZSBhcyBhIHBhcmFtZXRlci4gIFVzZSB0aGlzIGluc3RhbmNlIG9mIFBhcnNlXG4vLyAgICAgICAgICB0byByZWdpc3RlciB5b3VyIGNsb3VkIGNvZGUgaG9va3MgYW5kIGZ1bmN0aW9ucy5cbi8vIFwiYXBwSWRcIjogdGhlIGFwcGxpY2F0aW9uIGlkIHRvIGhvc3Rcbi8vIFwibWFzdGVyS2V5XCI6IHRoZSBtYXN0ZXIga2V5IGZvciByZXF1ZXN0cyB0byB0aGlzIGFwcFxuLy8gXCJjb2xsZWN0aW9uUHJlZml4XCI6IG9wdGlvbmFsIHByZWZpeCBmb3IgZGF0YWJhc2UgY29sbGVjdGlvbiBuYW1lc1xuLy8gXCJmaWxlS2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZCBmb3Igc3VwcG9ydGluZyBvbGRlciBmaWxlc1xuLy8gICAgICAgICAgICBob3N0ZWQgYnkgUGFyc2Vcbi8vIFwiY2xpZW50S2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZFxuLy8gXCJkb3ROZXRLZXlcIjogb3B0aW9uYWwga2V5IGZyb20gUGFyc2UgZGFzaGJvYXJkXG4vLyBcInJlc3RBUElLZXlcIjogb3B0aW9uYWwga2V5IGZyb20gUGFyc2UgZGFzaGJvYXJkXG4vLyBcIndlYmhvb2tLZXlcIjogb3B0aW9uYWwga2V5IGZyb20gUGFyc2UgZGFzaGJvYXJkXG4vLyBcImphdmFzY3JpcHRLZXlcIjogb3B0aW9uYWwga2V5IGZyb20gUGFyc2UgZGFzaGJvYXJkXG4vLyBcInB1c2hcIjogb3B0aW9uYWwga2V5IGZyb20gY29uZmlndXJlIHB1c2hcbi8vIFwic2Vzc2lvbkxlbmd0aFwiOiBvcHRpb25hbCBsZW5ndGggaW4gc2Vjb25kcyBmb3IgaG93IGxvbmcgU2Vzc2lvbnMgc2hvdWxkIGJlIHZhbGlkIGZvclxuLy8gXCJtYXhMaW1pdFwiOiBvcHRpb25hbCB1cHBlciBib3VuZCBmb3Igd2hhdCBjYW4gYmUgc3BlY2lmaWVkIGZvciB0aGUgJ2xpbWl0JyBwYXJhbWV0ZXIgb24gcXVlcmllc1xuXG5jbGFzcyBQYXJzZVNlcnZlciB7XG4gIC8qKlxuICAgKiBAY29uc3RydWN0b3JcbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdGhlIHBhcnNlIHNlcnZlciBpbml0aWFsaXphdGlvbiBvcHRpb25zXG4gICAqL1xuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgICBpbmplY3REZWZhdWx0cyhvcHRpb25zKTtcbiAgICBjb25zdCB7XG4gICAgICBhcHBJZCA9IHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGFuIGFwcElkIScpLFxuICAgICAgbWFzdGVyS2V5ID0gcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYSBtYXN0ZXJLZXkhJyksXG4gICAgICBjbG91ZCxcbiAgICAgIGphdmFzY3JpcHRLZXksXG4gICAgICBzZXJ2ZXJVUkwgPSByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIHNlcnZlclVSTCEnKSxcbiAgICAgIHNlcnZlclN0YXJ0Q29tcGxldGUsXG4gICAgfSA9IG9wdGlvbnM7XG4gICAgLy8gSW5pdGlhbGl6ZSB0aGUgbm9kZSBjbGllbnQgU0RLIGF1dG9tYXRpY2FsbHlcbiAgICBQYXJzZS5pbml0aWFsaXplKGFwcElkLCBqYXZhc2NyaXB0S2V5IHx8ICd1bnVzZWQnLCBtYXN0ZXJLZXkpO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcblxuICAgIGNvbnN0IGFsbENvbnRyb2xsZXJzID0gY29udHJvbGxlcnMuZ2V0Q29udHJvbGxlcnMob3B0aW9ucyk7XG5cbiAgICBjb25zdCB7XG4gICAgICBsb2dnZXJDb250cm9sbGVyLFxuICAgICAgZGF0YWJhc2VDb250cm9sbGVyLFxuICAgICAgaG9va3NDb250cm9sbGVyLFxuICAgIH0gPSBhbGxDb250cm9sbGVycztcbiAgICB0aGlzLmNvbmZpZyA9IENvbmZpZy5wdXQoT2JqZWN0LmFzc2lnbih7fSwgb3B0aW9ucywgYWxsQ29udHJvbGxlcnMpKTtcblxuICAgIGxvZ2dpbmcuc2V0TG9nZ2VyKGxvZ2dlckNvbnRyb2xsZXIpO1xuICAgIGNvbnN0IGRiSW5pdFByb21pc2UgPSBkYXRhYmFzZUNvbnRyb2xsZXIucGVyZm9ybUluaXRpYWxpemF0aW9uKCk7XG4gICAgY29uc3QgaG9va3NMb2FkUHJvbWlzZSA9IGhvb2tzQ29udHJvbGxlci5sb2FkKCk7XG5cbiAgICAvLyBOb3RlOiBUZXN0cyB3aWxsIHN0YXJ0IHRvIGZhaWwgaWYgYW55IHZhbGlkYXRpb24gaGFwcGVucyBhZnRlciB0aGlzIGlzIGNhbGxlZC5cbiAgICBQcm9taXNlLmFsbChbZGJJbml0UHJvbWlzZSwgaG9va3NMb2FkUHJvbWlzZV0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGlmIChzZXJ2ZXJTdGFydENvbXBsZXRlKSB7XG4gICAgICAgICAgc2VydmVyU3RhcnRDb21wbGV0ZSgpO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKHNlcnZlclN0YXJ0Q29tcGxldGUpIHtcbiAgICAgICAgICBzZXJ2ZXJTdGFydENvbXBsZXRlKGVycm9yKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICBpZiAoY2xvdWQpIHtcbiAgICAgIGFkZFBhcnNlQ2xvdWQoKTtcbiAgICAgIGlmICh0eXBlb2YgY2xvdWQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2xvdWQoUGFyc2UpO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgY2xvdWQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHJlcXVpcmUocGF0aC5yZXNvbHZlKHByb2Nlc3MuY3dkKCksIGNsb3VkKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBcImFyZ3VtZW50ICdjbG91ZCcgbXVzdCBlaXRoZXIgYmUgYSBzdHJpbmcgb3IgYSBmdW5jdGlvblwiO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGdldCBhcHAoKSB7XG4gICAgaWYgKCF0aGlzLl9hcHApIHtcbiAgICAgIHRoaXMuX2FwcCA9IFBhcnNlU2VydmVyLmFwcCh0aGlzLmNvbmZpZyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9hcHA7XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBjb25zdCB7IGFkYXB0ZXIgfSA9IHRoaXMuY29uZmlnLmRhdGFiYXNlQ29udHJvbGxlcjtcbiAgICBpZiAoYWRhcHRlciAmJiB0eXBlb2YgYWRhcHRlci5oYW5kbGVTaHV0ZG93biA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgYWRhcHRlci5oYW5kbGVTaHV0ZG93bigpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBAc3RhdGljXG4gICAqIENyZWF0ZSBhbiBleHByZXNzIGFwcCBmb3IgdGhlIHBhcnNlIHNlcnZlclxuICAgKiBAcGFyYW0ge09iamVjdH0gb3B0aW9ucyBsZXQgeW91IHNwZWNpZnkgdGhlIG1heFVwbG9hZFNpemUgd2hlbiBjcmVhdGluZyB0aGUgZXhwcmVzcyBhcHAgICovXG4gIHN0YXRpYyBhcHAoeyBtYXhVcGxvYWRTaXplID0gJzIwbWInLCBhcHBJZCwgZGlyZWN0QWNjZXNzIH0pIHtcbiAgICAvLyBUaGlzIGFwcCBzZXJ2ZXMgdGhlIFBhcnNlIEFQSSBkaXJlY3RseS5cbiAgICAvLyBJdCdzIHRoZSBlcXVpdmFsZW50IG9mIGh0dHBzOi8vYXBpLnBhcnNlLmNvbS8xIGluIHRoZSBob3N0ZWQgUGFyc2UgQVBJLlxuICAgIHZhciBhcGkgPSBleHByZXNzKCk7XG4gICAgLy9hcGkudXNlKFwiL2FwcHNcIiwgZXhwcmVzcy5zdGF0aWMoX19kaXJuYW1lICsgXCIvcHVibGljXCIpKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmFsbG93Q3Jvc3NEb21haW4pO1xuICAgIC8vIEZpbGUgaGFuZGxpbmcgbmVlZHMgdG8gYmUgYmVmb3JlIGRlZmF1bHQgbWlkZGxld2FyZXMgYXJlIGFwcGxpZWRcbiAgICBhcGkudXNlKFxuICAgICAgJy8nLFxuICAgICAgbmV3IEZpbGVzUm91dGVyKCkuZXhwcmVzc1JvdXRlcih7XG4gICAgICAgIG1heFVwbG9hZFNpemU6IG1heFVwbG9hZFNpemUsXG4gICAgICB9KVxuICAgICk7XG5cbiAgICBhcGkudXNlKCcvaGVhbHRoJywgZnVuY3Rpb24ocmVxLCByZXMpIHtcbiAgICAgIHJlcy5qc29uKHtcbiAgICAgICAgc3RhdHVzOiAnb2snLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBhcGkudXNlKFxuICAgICAgJy8nLFxuICAgICAgYm9keVBhcnNlci51cmxlbmNvZGVkKHsgZXh0ZW5kZWQ6IGZhbHNlIH0pLFxuICAgICAgbmV3IFB1YmxpY0FQSVJvdXRlcigpLmV4cHJlc3NSb3V0ZXIoKVxuICAgICk7XG5cbiAgICBhcGkudXNlKGJvZHlQYXJzZXIuanNvbih7IHR5cGU6ICcqLyonLCBsaW1pdDogbWF4VXBsb2FkU2l6ZSB9KSk7XG4gICAgYXBpLnVzZShtaWRkbGV3YXJlcy5hbGxvd01ldGhvZE92ZXJyaWRlKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlSGVhZGVycyk7XG5cbiAgICBjb25zdCBhcHBSb3V0ZXIgPSBQYXJzZVNlcnZlci5wcm9taXNlUm91dGVyKHsgYXBwSWQgfSk7XG4gICAgYXBpLnVzZShhcHBSb3V0ZXIuZXhwcmVzc1JvdXRlcigpKTtcblxuICAgIGFwaS51c2UobWlkZGxld2FyZXMuaGFuZGxlUGFyc2VFcnJvcnMpO1xuXG4gICAgLy8gcnVuIHRoZSBmb2xsb3dpbmcgd2hlbiBub3QgdGVzdGluZ1xuICAgIGlmICghcHJvY2Vzcy5lbnYuVEVTVElORykge1xuICAgICAgLy9UaGlzIGNhdXNlcyB0ZXN0cyB0byBzcGV3IHNvbWUgdXNlbGVzcyB3YXJuaW5ncywgc28gZGlzYWJsZSBpbiB0ZXN0XG4gICAgICAvKiBpc3RhbmJ1bCBpZ25vcmUgbmV4dCAqL1xuICAgICAgcHJvY2Vzcy5vbigndW5jYXVnaHRFeGNlcHRpb24nLCBlcnIgPT4ge1xuICAgICAgICBpZiAoZXJyLmNvZGUgPT09ICdFQUREUklOVVNFJykge1xuICAgICAgICAgIC8vIHVzZXItZnJpZW5kbHkgbWVzc2FnZSBmb3IgdGhpcyBjb21tb24gZXJyb3JcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGBVbmFibGUgdG8gbGlzdGVuIG9uIHBvcnQgJHtlcnIucG9ydH0uIFRoZSBwb3J0IGlzIGFscmVhZHkgaW4gdXNlLmBcbiAgICAgICAgICApO1xuICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gdmVyaWZ5IHRoZSBzZXJ2ZXIgdXJsIGFmdGVyIGEgJ21vdW50JyBldmVudCBpcyByZWNlaXZlZFxuICAgICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICAgIGFwaS5vbignbW91bnQnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgUGFyc2VTZXJ2ZXIudmVyaWZ5U2VydmVyVXJsKCk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKFxuICAgICAgcHJvY2Vzcy5lbnYuUEFSU0VfU0VSVkVSX0VOQUJMRV9FWFBFUklNRU5UQUxfRElSRUNUX0FDQ0VTUyA9PT0gJzEnIHx8XG4gICAgICBkaXJlY3RBY2Nlc3NcbiAgICApIHtcbiAgICAgIFBhcnNlLkNvcmVNYW5hZ2VyLnNldFJFU1RDb250cm9sbGVyKFxuICAgICAgICBQYXJzZVNlcnZlclJFU1RDb250cm9sbGVyKGFwcElkLCBhcHBSb3V0ZXIpXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gYXBpO1xuICB9XG5cbiAgc3RhdGljIHByb21pc2VSb3V0ZXIoeyBhcHBJZCB9KSB7XG4gICAgY29uc3Qgcm91dGVycyA9IFtcbiAgICAgIG5ldyBDbGFzc2VzUm91dGVyKCksXG4gICAgICBuZXcgVXNlcnNSb3V0ZXIoKSxcbiAgICAgIG5ldyBTZXNzaW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFJvbGVzUm91dGVyKCksXG4gICAgICBuZXcgQW5hbHl0aWNzUm91dGVyKCksXG4gICAgICBuZXcgSW5zdGFsbGF0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IEZ1bmN0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFNjaGVtYXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBQdXNoUm91dGVyKCksXG4gICAgICBuZXcgTG9nc1JvdXRlcigpLFxuICAgICAgbmV3IElBUFZhbGlkYXRpb25Sb3V0ZXIoKSxcbiAgICAgIG5ldyBGZWF0dXJlc1JvdXRlcigpLFxuICAgICAgbmV3IEdsb2JhbENvbmZpZ1JvdXRlcigpLFxuICAgICAgbmV3IFB1cmdlUm91dGVyKCksXG4gICAgICBuZXcgSG9va3NSb3V0ZXIoKSxcbiAgICAgIG5ldyBDbG91ZENvZGVSb3V0ZXIoKSxcbiAgICAgIG5ldyBBdWRpZW5jZXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBBZ2dyZWdhdGVSb3V0ZXIoKSxcbiAgICBdO1xuXG4gICAgY29uc3Qgcm91dGVzID0gcm91dGVycy5yZWR1Y2UoKG1lbW8sIHJvdXRlcikgPT4ge1xuICAgICAgcmV0dXJuIG1lbW8uY29uY2F0KHJvdXRlci5yb3V0ZXMpO1xuICAgIH0sIFtdKTtcblxuICAgIGNvbnN0IGFwcFJvdXRlciA9IG5ldyBQcm9taXNlUm91dGVyKHJvdXRlcywgYXBwSWQpO1xuXG4gICAgYmF0Y2gubW91bnRPbnRvKGFwcFJvdXRlcik7XG4gICAgcmV0dXJuIGFwcFJvdXRlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBzdGFydHMgdGhlIHBhcnNlIHNlcnZlcidzIGV4cHJlc3MgYXBwXG4gICAqIEBwYXJhbSB7UGFyc2VTZXJ2ZXJPcHRpb25zfSBvcHRpb25zIHRvIHVzZSB0byBzdGFydCB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGNhbGxiYWNrIGNhbGxlZCB3aGVuIHRoZSBzZXJ2ZXIgaGFzIHN0YXJ0ZWRcbiAgICogQHJldHVybnMge1BhcnNlU2VydmVyfSB0aGUgcGFyc2Ugc2VydmVyIGluc3RhbmNlXG4gICAqL1xuICBzdGFydChvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMsIGNhbGxiYWNrOiA/KCkgPT4gdm9pZCkge1xuICAgIGNvbnN0IGFwcCA9IGV4cHJlc3MoKTtcbiAgICBpZiAob3B0aW9ucy5taWRkbGV3YXJlKSB7XG4gICAgICBsZXQgbWlkZGxld2FyZTtcbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5taWRkbGV3YXJlID09ICdzdHJpbmcnKSB7XG4gICAgICAgIG1pZGRsZXdhcmUgPSByZXF1aXJlKHBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCBvcHRpb25zLm1pZGRsZXdhcmUpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1pZGRsZXdhcmUgPSBvcHRpb25zLm1pZGRsZXdhcmU7IC8vIHVzZSBhcy1pcyBsZXQgZXhwcmVzcyBmYWlsXG4gICAgICB9XG4gICAgICBhcHAudXNlKG1pZGRsZXdhcmUpO1xuICAgIH1cblxuICAgIGFwcC51c2Uob3B0aW9ucy5tb3VudFBhdGgsIHRoaXMuYXBwKTtcblxuICAgIGlmIChvcHRpb25zLm1vdW50R3JhcGhRTCA9PT0gdHJ1ZSB8fCBvcHRpb25zLm1vdW50UGxheWdyb3VuZCA9PT0gdHJ1ZSkge1xuICAgICAgY29uc3QgcGFyc2VHcmFwaFFMU2VydmVyID0gbmV3IFBhcnNlR3JhcGhRTFNlcnZlcih0aGlzLCB7XG4gICAgICAgIGdyYXBoUUxQYXRoOiBvcHRpb25zLmdyYXBoUUxQYXRoLFxuICAgICAgICBwbGF5Z3JvdW5kUGF0aDogb3B0aW9ucy5wbGF5Z3JvdW5kUGF0aCxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAob3B0aW9ucy5tb3VudEdyYXBoUUwpIHtcbiAgICAgICAgcGFyc2VHcmFwaFFMU2VydmVyLmFwcGx5R3JhcGhRTChhcHApO1xuICAgICAgfVxuXG4gICAgICBpZiAob3B0aW9ucy5tb3VudFBsYXlncm91bmQpIHtcbiAgICAgICAgcGFyc2VHcmFwaFFMU2VydmVyLmFwcGx5UGxheWdyb3VuZChhcHApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHNlcnZlciA9IGFwcC5saXN0ZW4ob3B0aW9ucy5wb3J0LCBvcHRpb25zLmhvc3QsIGNhbGxiYWNrKTtcbiAgICB0aGlzLnNlcnZlciA9IHNlcnZlcjtcblxuICAgIGlmIChvcHRpb25zLnN0YXJ0TGl2ZVF1ZXJ5U2VydmVyIHx8IG9wdGlvbnMubGl2ZVF1ZXJ5U2VydmVyT3B0aW9ucykge1xuICAgICAgdGhpcy5saXZlUXVlcnlTZXJ2ZXIgPSBQYXJzZVNlcnZlci5jcmVhdGVMaXZlUXVlcnlTZXJ2ZXIoXG4gICAgICAgIHNlcnZlcixcbiAgICAgICAgb3B0aW9ucy5saXZlUXVlcnlTZXJ2ZXJPcHRpb25zXG4gICAgICApO1xuICAgIH1cbiAgICAvKiBpc3RhbmJ1bCBpZ25vcmUgbmV4dCAqL1xuICAgIGlmICghcHJvY2Vzcy5lbnYuVEVTVElORykge1xuICAgICAgY29uZmlndXJlTGlzdGVuZXJzKHRoaXMpO1xuICAgIH1cbiAgICB0aGlzLmV4cHJlc3NBcHAgPSBhcHA7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlcyBhIG5ldyBQYXJzZVNlcnZlciBhbmQgc3RhcnRzIGl0LlxuICAgKiBAcGFyYW0ge1BhcnNlU2VydmVyT3B0aW9uc30gb3B0aW9ucyB1c2VkIHRvIHN0YXJ0IHRoZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gY2FsbGJhY2sgY2FsbGVkIHdoZW4gdGhlIHNlcnZlciBoYXMgc3RhcnRlZFxuICAgKiBAcmV0dXJucyB7UGFyc2VTZXJ2ZXJ9IHRoZSBwYXJzZSBzZXJ2ZXIgaW5zdGFuY2VcbiAgICovXG4gIHN0YXRpYyBzdGFydChvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMsIGNhbGxiYWNrOiA/KCkgPT4gdm9pZCkge1xuICAgIGNvbnN0IHBhcnNlU2VydmVyID0gbmV3IFBhcnNlU2VydmVyKG9wdGlvbnMpO1xuICAgIHJldHVybiBwYXJzZVNlcnZlci5zdGFydChvcHRpb25zLCBjYWxsYmFjayk7XG4gIH1cblxuICAvKipcbiAgICogSGVscGVyIG1ldGhvZCB0byBjcmVhdGUgYSBsaXZlUXVlcnkgc2VydmVyXG4gICAqIEBzdGF0aWNcbiAgICogQHBhcmFtIHtTZXJ2ZXJ9IGh0dHBTZXJ2ZXIgYW4gb3B0aW9uYWwgaHR0cCBzZXJ2ZXIgdG8gcGFzc1xuICAgKiBAcGFyYW0ge0xpdmVRdWVyeVNlcnZlck9wdGlvbnN9IGNvbmZpZyBvcHRpb25zIGZvdCBoZSBsaXZlUXVlcnlTZXJ2ZXJcbiAgICogQHJldHVybnMge1BhcnNlTGl2ZVF1ZXJ5U2VydmVyfSB0aGUgbGl2ZSBxdWVyeSBzZXJ2ZXIgaW5zdGFuY2VcbiAgICovXG4gIHN0YXRpYyBjcmVhdGVMaXZlUXVlcnlTZXJ2ZXIoaHR0cFNlcnZlciwgY29uZmlnOiBMaXZlUXVlcnlTZXJ2ZXJPcHRpb25zKSB7XG4gICAgaWYgKCFodHRwU2VydmVyIHx8IChjb25maWcgJiYgY29uZmlnLnBvcnQpKSB7XG4gICAgICB2YXIgYXBwID0gZXhwcmVzcygpO1xuICAgICAgaHR0cFNlcnZlciA9IHJlcXVpcmUoJ2h0dHAnKS5jcmVhdGVTZXJ2ZXIoYXBwKTtcbiAgICAgIGh0dHBTZXJ2ZXIubGlzdGVuKGNvbmZpZy5wb3J0KTtcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBQYXJzZUxpdmVRdWVyeVNlcnZlcihodHRwU2VydmVyLCBjb25maWcpO1xuICB9XG5cbiAgc3RhdGljIHZlcmlmeVNlcnZlclVybChjYWxsYmFjaykge1xuICAgIC8vIHBlcmZvcm0gYSBoZWFsdGggY2hlY2sgb24gdGhlIHNlcnZlclVSTCB2YWx1ZVxuICAgIGlmIChQYXJzZS5zZXJ2ZXJVUkwpIHtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSByZXF1aXJlKCcuL3JlcXVlc3QnKTtcbiAgICAgIHJlcXVlc3QoeyB1cmw6IFBhcnNlLnNlcnZlclVSTC5yZXBsYWNlKC9cXC8kLywgJycpICsgJy9oZWFsdGgnIH0pXG4gICAgICAgIC5jYXRjaChyZXNwb25zZSA9PiByZXNwb25zZSlcbiAgICAgICAgLnRoZW4ocmVzcG9uc2UgPT4ge1xuICAgICAgICAgIGNvbnN0IGpzb24gPSByZXNwb25zZS5kYXRhIHx8IG51bGw7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgcmVzcG9uc2Uuc3RhdHVzICE9PSAyMDAgfHxcbiAgICAgICAgICAgICFqc29uIHx8XG4gICAgICAgICAgICAoanNvbiAmJiBqc29uLnN0YXR1cyAhPT0gJ29rJylcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIC8qIGVzbGludC1kaXNhYmxlIG5vLWNvbnNvbGUgKi9cbiAgICAgICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICAgICAgYFxcbldBUk5JTkcsIFVuYWJsZSB0byBjb25uZWN0IHRvICcke1BhcnNlLnNlcnZlclVSTH0nLmAgK1xuICAgICAgICAgICAgICAgIGAgQ2xvdWQgY29kZSBhbmQgcHVzaCBub3RpZmljYXRpb25zIG1heSBiZSB1bmF2YWlsYWJsZSFcXG5gXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgLyogZXNsaW50LWVuYWJsZSBuby1jb25zb2xlICovXG4gICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2soZmFsc2UpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgY2FsbGJhY2sodHJ1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYWRkUGFyc2VDbG91ZCgpIHtcbiAgY29uc3QgUGFyc2VDbG91ZCA9IHJlcXVpcmUoJy4vY2xvdWQtY29kZS9QYXJzZS5DbG91ZCcpO1xuICBPYmplY3QuYXNzaWduKFBhcnNlLkNsb3VkLCBQYXJzZUNsb3VkKTtcbiAgZ2xvYmFsLlBhcnNlID0gUGFyc2U7XG59XG5cbmZ1bmN0aW9uIGluamVjdERlZmF1bHRzKG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucykge1xuICBPYmplY3Qua2V5cyhkZWZhdWx0cykuZm9yRWFjaChrZXkgPT4ge1xuICAgIGlmICghb3B0aW9ucy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICBvcHRpb25zW2tleV0gPSBkZWZhdWx0c1trZXldO1xuICAgIH1cbiAgfSk7XG5cbiAgaWYgKCFvcHRpb25zLmhhc093blByb3BlcnR5KCdzZXJ2ZXJVUkwnKSkge1xuICAgIG9wdGlvbnMuc2VydmVyVVJMID0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtvcHRpb25zLnBvcnR9JHtvcHRpb25zLm1vdW50UGF0aH1gO1xuICB9XG5cbiAgLy8gQmFja3dhcmRzIGNvbXBhdGliaWxpdHlcbiAgaWYgKG9wdGlvbnMudXNlclNlbnNpdGl2ZUZpZWxkcykge1xuICAgIC8qIGVzbGludC1kaXNhYmxlIG5vLWNvbnNvbGUgKi9cbiAgICAhcHJvY2Vzcy5lbnYuVEVTVElORyAmJlxuICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICBgXFxuREVQUkVDQVRFRDogdXNlclNlbnNpdGl2ZUZpZWxkcyBoYXMgYmVlbiByZXBsYWNlZCBieSBwcm90ZWN0ZWRGaWVsZHMgYWxsb3dpbmcgdGhlIGFiaWxpdHkgdG8gcHJvdGVjdCBmaWVsZHMgaW4gYWxsIGNsYXNzZXMgd2l0aCBDTFAuIFxcbmBcbiAgICAgICk7XG4gICAgLyogZXNsaW50LWVuYWJsZSBuby1jb25zb2xlICovXG5cbiAgICBjb25zdCB1c2VyU2Vuc2l0aXZlRmllbGRzID0gQXJyYXkuZnJvbShcbiAgICAgIG5ldyBTZXQoW1xuICAgICAgICAuLi4oZGVmYXVsdHMudXNlclNlbnNpdGl2ZUZpZWxkcyB8fCBbXSksXG4gICAgICAgIC4uLihvcHRpb25zLnVzZXJTZW5zaXRpdmVGaWVsZHMgfHwgW10pLFxuICAgICAgXSlcbiAgICApO1xuXG4gICAgLy8gSWYgdGhlIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzIGlzIHVuc2V0LFxuICAgIC8vIGl0J2xsIGJlIGFzc2lnbmVkIHRoZSBkZWZhdWx0IGFib3ZlLlxuICAgIC8vIEhlcmUsIHByb3RlY3QgYWdhaW5zdCB0aGUgY2FzZSB3aGVyZSBwcm90ZWN0ZWRGaWVsZHNcbiAgICAvLyBpcyBzZXQsIGJ1dCBkb2Vzbid0IGhhdmUgX1VzZXIuXG4gICAgaWYgKCEoJ19Vc2VyJyBpbiBvcHRpb25zLnByb3RlY3RlZEZpZWxkcykpIHtcbiAgICAgIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzID0gT2JqZWN0LmFzc2lnbihcbiAgICAgICAgeyBfVXNlcjogW10gfSxcbiAgICAgICAgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNcbiAgICAgICk7XG4gICAgfVxuXG4gICAgb3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNbJ19Vc2VyJ11bJyonXSA9IEFycmF5LmZyb20oXG4gICAgICBuZXcgU2V0KFtcbiAgICAgICAgLi4uKG9wdGlvbnMucHJvdGVjdGVkRmllbGRzWydfVXNlciddWycqJ10gfHwgW10pLFxuICAgICAgICAuLi51c2VyU2Vuc2l0aXZlRmllbGRzLFxuICAgICAgXSlcbiAgICApO1xuICB9XG5cbiAgLy8gTWVyZ2UgcHJvdGVjdGVkRmllbGRzIG9wdGlvbnMgd2l0aCBkZWZhdWx0cy5cbiAgT2JqZWN0LmtleXMoZGVmYXVsdHMucHJvdGVjdGVkRmllbGRzKS5mb3JFYWNoKGMgPT4ge1xuICAgIGNvbnN0IGN1ciA9IG9wdGlvbnMucHJvdGVjdGVkRmllbGRzW2NdO1xuICAgIGlmICghY3VyKSB7XG4gICAgICBvcHRpb25zLnByb3RlY3RlZEZpZWxkc1tjXSA9IGRlZmF1bHRzLnByb3RlY3RlZEZpZWxkc1tjXTtcbiAgICB9IGVsc2Uge1xuICAgICAgT2JqZWN0LmtleXMoZGVmYXVsdHMucHJvdGVjdGVkRmllbGRzW2NdKS5mb3JFYWNoKHIgPT4ge1xuICAgICAgICBjb25zdCB1bnEgPSBuZXcgU2V0KFtcbiAgICAgICAgICAuLi4ob3B0aW9ucy5wcm90ZWN0ZWRGaWVsZHNbY11bcl0gfHwgW10pLFxuICAgICAgICAgIC4uLmRlZmF1bHRzLnByb3RlY3RlZEZpZWxkc1tjXVtyXSxcbiAgICAgICAgXSk7XG4gICAgICAgIG9wdGlvbnMucHJvdGVjdGVkRmllbGRzW2NdW3JdID0gQXJyYXkuZnJvbSh1bnEpO1xuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICBvcHRpb25zLm1hc3RlcktleUlwcyA9IEFycmF5LmZyb20oXG4gICAgbmV3IFNldChcbiAgICAgIG9wdGlvbnMubWFzdGVyS2V5SXBzLmNvbmNhdChkZWZhdWx0cy5tYXN0ZXJLZXlJcHMsIG9wdGlvbnMubWFzdGVyS2V5SXBzKVxuICAgIClcbiAgKTtcbn1cblxuLy8gVGhvc2UgY2FuJ3QgYmUgdGVzdGVkIGFzIGl0IHJlcXVpcmVzIGEgc3VicHJvY2Vzc1xuLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbmZ1bmN0aW9uIGNvbmZpZ3VyZUxpc3RlbmVycyhwYXJzZVNlcnZlcikge1xuICBjb25zdCBzZXJ2ZXIgPSBwYXJzZVNlcnZlci5zZXJ2ZXI7XG4gIGNvbnN0IHNvY2tldHMgPSB7fTtcbiAgLyogQ3VycmVudGx5LCBleHByZXNzIGRvZXNuJ3Qgc2h1dCBkb3duIGltbWVkaWF0ZWx5IGFmdGVyIHJlY2VpdmluZyBTSUdJTlQvU0lHVEVSTSBpZiBpdCBoYXMgY2xpZW50IGNvbm5lY3Rpb25zIHRoYXQgaGF2ZW4ndCB0aW1lZCBvdXQuIChUaGlzIGlzIGEga25vd24gaXNzdWUgd2l0aCBub2RlIC0gaHR0cHM6Ly9naXRodWIuY29tL25vZGVqcy9ub2RlL2lzc3Vlcy8yNjQyKVxuICAgIFRoaXMgZnVuY3Rpb24sIGFsb25nIHdpdGggYGRlc3Ryb3lBbGl2ZUNvbm5lY3Rpb25zKClgLCBpbnRlbmQgdG8gZml4IHRoaXMgYmVoYXZpb3Igc3VjaCB0aGF0IHBhcnNlIHNlcnZlciB3aWxsIGNsb3NlIGFsbCBvcGVuIGNvbm5lY3Rpb25zIGFuZCBpbml0aWF0ZSB0aGUgc2h1dGRvd24gcHJvY2VzcyBhcyBzb29uIGFzIGl0IHJlY2VpdmVzIGEgU0lHSU5UL1NJR1RFUk0gc2lnbmFsLiAqL1xuICBzZXJ2ZXIub24oJ2Nvbm5lY3Rpb24nLCBzb2NrZXQgPT4ge1xuICAgIGNvbnN0IHNvY2tldElkID0gc29ja2V0LnJlbW90ZUFkZHJlc3MgKyAnOicgKyBzb2NrZXQucmVtb3RlUG9ydDtcbiAgICBzb2NrZXRzW3NvY2tldElkXSA9IHNvY2tldDtcbiAgICBzb2NrZXQub24oJ2Nsb3NlJywgKCkgPT4ge1xuICAgICAgZGVsZXRlIHNvY2tldHNbc29ja2V0SWRdO1xuICAgIH0pO1xuICB9KTtcblxuICBjb25zdCBkZXN0cm95QWxpdmVDb25uZWN0aW9ucyA9IGZ1bmN0aW9uKCkge1xuICAgIGZvciAoY29uc3Qgc29ja2V0SWQgaW4gc29ja2V0cykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgc29ja2V0c1tzb2NrZXRJZF0uZGVzdHJveSgpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAvKiAqL1xuICAgICAgfVxuICAgIH1cbiAgfTtcblxuICBjb25zdCBoYW5kbGVTaHV0ZG93biA9IGZ1bmN0aW9uKCkge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKCdUZXJtaW5hdGlvbiBzaWduYWwgcmVjZWl2ZWQuIFNodXR0aW5nIGRvd24uJyk7XG4gICAgZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMoKTtcbiAgICBzZXJ2ZXIuY2xvc2UoKTtcbiAgICBwYXJzZVNlcnZlci5oYW5kbGVTaHV0ZG93bigpO1xuICB9O1xuICBwcm9jZXNzLm9uKCdTSUdURVJNJywgaGFuZGxlU2h1dGRvd24pO1xuICBwcm9jZXNzLm9uKCdTSUdJTlQnLCBoYW5kbGVTaHV0ZG93bik7XG59XG5cbmV4cG9ydCBkZWZhdWx0IFBhcnNlU2VydmVyO1xuIl19