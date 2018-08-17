'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _Options = require('./Options');

var _defaults = require('./defaults');

var _defaults2 = _interopRequireDefault(_defaults);

var _logger = require('./logger');

var logging = _interopRequireWildcard(_logger);

var _Config = require('./Config');

var _Config2 = _interopRequireDefault(_Config);

var _PromiseRouter = require('./PromiseRouter');

var _PromiseRouter2 = _interopRequireDefault(_PromiseRouter);

var _requiredParameter = require('./requiredParameter');

var _requiredParameter2 = _interopRequireDefault(_requiredParameter);

var _AnalyticsRouter = require('./Routers/AnalyticsRouter');

var _ClassesRouter = require('./Routers/ClassesRouter');

var _FeaturesRouter = require('./Routers/FeaturesRouter');

var _FilesRouter = require('./Routers/FilesRouter');

var _FunctionsRouter = require('./Routers/FunctionsRouter');

var _GlobalConfigRouter = require('./Routers/GlobalConfigRouter');

var _HooksRouter = require('./Routers/HooksRouter');

var _IAPValidationRouter = require('./Routers/IAPValidationRouter');

var _InstallationsRouter = require('./Routers/InstallationsRouter');

var _LogsRouter = require('./Routers/LogsRouter');

var _ParseLiveQueryServer = require('./LiveQuery/ParseLiveQueryServer');

var _PublicAPIRouter = require('./Routers/PublicAPIRouter');

var _PushRouter = require('./Routers/PushRouter');

var _CloudCodeRouter = require('./Routers/CloudCodeRouter');

var _RolesRouter = require('./Routers/RolesRouter');

var _SchemasRouter = require('./Routers/SchemasRouter');

var _SessionsRouter = require('./Routers/SessionsRouter');

var _UsersRouter = require('./Routers/UsersRouter');

var _PurgeRouter = require('./Routers/PurgeRouter');

var _AudiencesRouter = require('./Routers/AudiencesRouter');

var _AggregateRouter = require('./Routers/AggregateRouter');

var _ParseServerRESTController = require('./ParseServerRESTController');

var _Controllers = require('./Controllers');

var controllers = _interopRequireWildcard(_Controllers);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// ParseServer - open-source compatible API Server for Parse apps

var batch = require('./batch'),
    bodyParser = require('body-parser'),
    express = require('express'),
    middlewares = require('./middlewares'),
    Parse = require('parse/node').Parse,
    path = require('path');

// Mutate the Parse object to add the Cloud Code handlers
addParseCloud();

// ParseServer works like a constructor of an express app.
// The args that we understand are:
// "analyticsAdapter": an adapter class for analytics
// "filesAdapter": a class like GridStoreAdapter providing create, get,
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
      appId = (0, _requiredParameter2.default)('You must provide an appId!'),
      masterKey = (0, _requiredParameter2.default)('You must provide a masterKey!'),
      cloud,
      javascriptKey,
      serverURL = (0, _requiredParameter2.default)('You must provide a serverURL!'),
      __indexBuildCompletionCallbackForTests = () => {}
    } = options;
    // Initialize the node client SDK automatically
    Parse.initialize(appId, javascriptKey || 'unused', masterKey);
    Parse.serverURL = serverURL;

    const allControllers = controllers.getControllers(options);

    const {
      loggerController,
      databaseController,
      hooksController
    } = allControllers;
    this.config = _Config2.default.put(Object.assign({}, options, allControllers));

    logging.setLogger(loggerController);
    const dbInitPromise = databaseController.performInitialization();
    hooksController.load();

    // Note: Tests will start to fail if any validation happens after this is called.
    if (process.env.TESTING) {
      __indexBuildCompletionCallbackForTests(dbInitPromise);
    }

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
    const { adapter } = this.config.databaseController;
    if (adapter && typeof adapter.handleShutdown === 'function') {
      adapter.handleShutdown();
    }
  }

  /**
   * @static
   * Create an express app for the parse server
   * @param {Object} options let you specify the maxUploadSize when creating the express app  */
  static app({ maxUploadSize = '20mb', appId }) {
    // This app serves the Parse API directly.
    // It's the equivalent of https://api.parse.com/1 in the hosted Parse API.
    var api = express();
    //api.use("/apps", express.static(__dirname + "/public"));
    // File handling needs to be before default middlewares are applied
    api.use('/', middlewares.allowCrossDomain, new _FilesRouter.FilesRouter().expressRouter({
      maxUploadSize: maxUploadSize
    }));

    api.use('/health', function (req, res) {
      res.json({
        status: 'ok'
      });
    });

    api.use('/', bodyParser.urlencoded({ extended: false }), new _PublicAPIRouter.PublicAPIRouter().expressRouter());

    api.use(bodyParser.json({ 'type': '*/*', limit: maxUploadSize }));
    api.use(middlewares.allowCrossDomain);
    api.use(middlewares.allowMethodOverride);
    api.use(middlewares.handleParseHeaders);

    const appRouter = ParseServer.promiseRouter({ appId });
    api.use(appRouter.expressRouter());

    api.use(middlewares.handleParseErrors);

    // run the following when not testing
    if (!process.env.TESTING) {
      //This causes tests to spew some useless warnings, so disable in test
      /* istanbul ignore next */
      process.on('uncaughtException', err => {
        if (err.code === "EADDRINUSE") {
          // user-friendly message for this common error
          process.stderr.write(`Unable to listen on port ${err.port}. The port is already in use.`);
          process.exit(0);
        } else {
          throw err;
        }
      });
      // verify the server url after a 'mount' event is received
      /* istanbul ignore next */
      api.on('mount', function () {
        ParseServer.verifyServerUrl();
      });
    }
    if (process.env.PARSE_SERVER_ENABLE_EXPERIMENTAL_DIRECT_ACCESS === '1') {
      Parse.CoreManager.setRESTController((0, _ParseServerRESTController.ParseServerRESTController)(appId, appRouter));
    }
    return api;
  }

  static promiseRouter({ appId }) {
    const routers = [new _ClassesRouter.ClassesRouter(), new _UsersRouter.UsersRouter(), new _SessionsRouter.SessionsRouter(), new _RolesRouter.RolesRouter(), new _AnalyticsRouter.AnalyticsRouter(), new _InstallationsRouter.InstallationsRouter(), new _FunctionsRouter.FunctionsRouter(), new _SchemasRouter.SchemasRouter(), new _PushRouter.PushRouter(), new _LogsRouter.LogsRouter(), new _IAPValidationRouter.IAPValidationRouter(), new _FeaturesRouter.FeaturesRouter(), new _GlobalConfigRouter.GlobalConfigRouter(), new _PurgeRouter.PurgeRouter(), new _HooksRouter.HooksRouter(), new _CloudCodeRouter.CloudCodeRouter(), new _AudiencesRouter.AudiencesRouter(), new _AggregateRouter.AggregateRouter()];

    const routes = routers.reduce((memo, router) => {
      return memo.concat(router.routes);
    }, []);

    const appRouter = new _PromiseRouter2.default(routes, appId);

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
      const request = require('request');
      request(Parse.serverURL.replace(/\/$/, "") + "/health", function (error, response, body) {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = null;
        }
        if (error || response.statusCode !== 200 || !json || json && json.status !== 'ok') {
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
  const ParseCloud = require("./cloud-code/Parse.Cloud");
  Object.assign(Parse.Cloud, ParseCloud);
  global.Parse = Parse;
}

function injectDefaults(options) {
  Object.keys(_defaults2.default).forEach(key => {
    if (!options.hasOwnProperty(key)) {
      options[key] = _defaults2.default[key];
    }
  });

  if (!options.hasOwnProperty('serverURL')) {
    options.serverURL = `http://localhost:${options.port}${options.mountPath}`;
  }

  options.userSensitiveFields = Array.from(new Set(options.userSensitiveFields.concat(_defaults2.default.userSensitiveFields, options.userSensitiveFields)));

  options.masterKeyIps = Array.from(new Set(options.masterKeyIps.concat(_defaults2.default.masterKeyIps, options.masterKeyIps)));
}

// Those can't be tested as it requires a subprocess
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
      } catch (e) {/* */}
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

exports.default = ParseServer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9QYXJzZVNlcnZlci5qcyJdLCJuYW1lcyI6WyJsb2dnaW5nIiwiY29udHJvbGxlcnMiLCJiYXRjaCIsInJlcXVpcmUiLCJib2R5UGFyc2VyIiwiZXhwcmVzcyIsIm1pZGRsZXdhcmVzIiwiUGFyc2UiLCJwYXRoIiwiYWRkUGFyc2VDbG91ZCIsIlBhcnNlU2VydmVyIiwiY29uc3RydWN0b3IiLCJvcHRpb25zIiwiaW5qZWN0RGVmYXVsdHMiLCJhcHBJZCIsIm1hc3RlcktleSIsImNsb3VkIiwiamF2YXNjcmlwdEtleSIsInNlcnZlclVSTCIsIl9faW5kZXhCdWlsZENvbXBsZXRpb25DYWxsYmFja0ZvclRlc3RzIiwiaW5pdGlhbGl6ZSIsImFsbENvbnRyb2xsZXJzIiwiZ2V0Q29udHJvbGxlcnMiLCJsb2dnZXJDb250cm9sbGVyIiwiZGF0YWJhc2VDb250cm9sbGVyIiwiaG9va3NDb250cm9sbGVyIiwiY29uZmlnIiwiQ29uZmlnIiwicHV0IiwiT2JqZWN0IiwiYXNzaWduIiwic2V0TG9nZ2VyIiwiZGJJbml0UHJvbWlzZSIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsImxvYWQiLCJwcm9jZXNzIiwiZW52IiwiVEVTVElORyIsInJlc29sdmUiLCJjd2QiLCJhcHAiLCJfYXBwIiwiaGFuZGxlU2h1dGRvd24iLCJhZGFwdGVyIiwibWF4VXBsb2FkU2l6ZSIsImFwaSIsInVzZSIsImFsbG93Q3Jvc3NEb21haW4iLCJGaWxlc1JvdXRlciIsImV4cHJlc3NSb3V0ZXIiLCJyZXEiLCJyZXMiLCJqc29uIiwic3RhdHVzIiwidXJsZW5jb2RlZCIsImV4dGVuZGVkIiwiUHVibGljQVBJUm91dGVyIiwibGltaXQiLCJhbGxvd01ldGhvZE92ZXJyaWRlIiwiaGFuZGxlUGFyc2VIZWFkZXJzIiwiYXBwUm91dGVyIiwicHJvbWlzZVJvdXRlciIsImhhbmRsZVBhcnNlRXJyb3JzIiwib24iLCJlcnIiLCJjb2RlIiwic3RkZXJyIiwid3JpdGUiLCJwb3J0IiwiZXhpdCIsInZlcmlmeVNlcnZlclVybCIsIlBBUlNFX1NFUlZFUl9FTkFCTEVfRVhQRVJJTUVOVEFMX0RJUkVDVF9BQ0NFU1MiLCJDb3JlTWFuYWdlciIsInNldFJFU1RDb250cm9sbGVyIiwicm91dGVycyIsIkNsYXNzZXNSb3V0ZXIiLCJVc2Vyc1JvdXRlciIsIlNlc3Npb25zUm91dGVyIiwiUm9sZXNSb3V0ZXIiLCJBbmFseXRpY3NSb3V0ZXIiLCJJbnN0YWxsYXRpb25zUm91dGVyIiwiRnVuY3Rpb25zUm91dGVyIiwiU2NoZW1hc1JvdXRlciIsIlB1c2hSb3V0ZXIiLCJMb2dzUm91dGVyIiwiSUFQVmFsaWRhdGlvblJvdXRlciIsIkZlYXR1cmVzUm91dGVyIiwiR2xvYmFsQ29uZmlnUm91dGVyIiwiUHVyZ2VSb3V0ZXIiLCJIb29rc1JvdXRlciIsIkNsb3VkQ29kZVJvdXRlciIsIkF1ZGllbmNlc1JvdXRlciIsIkFnZ3JlZ2F0ZVJvdXRlciIsInJvdXRlcyIsInJlZHVjZSIsIm1lbW8iLCJyb3V0ZXIiLCJjb25jYXQiLCJQcm9taXNlUm91dGVyIiwibW91bnRPbnRvIiwic3RhcnQiLCJjYWxsYmFjayIsIm1pZGRsZXdhcmUiLCJtb3VudFBhdGgiLCJzZXJ2ZXIiLCJsaXN0ZW4iLCJob3N0Iiwic3RhcnRMaXZlUXVlcnlTZXJ2ZXIiLCJsaXZlUXVlcnlTZXJ2ZXJPcHRpb25zIiwibGl2ZVF1ZXJ5U2VydmVyIiwiY3JlYXRlTGl2ZVF1ZXJ5U2VydmVyIiwiY29uZmlndXJlTGlzdGVuZXJzIiwiZXhwcmVzc0FwcCIsInBhcnNlU2VydmVyIiwiaHR0cFNlcnZlciIsImNyZWF0ZVNlcnZlciIsIlBhcnNlTGl2ZVF1ZXJ5U2VydmVyIiwicmVxdWVzdCIsInJlcGxhY2UiLCJlcnJvciIsInJlc3BvbnNlIiwiYm9keSIsIkpTT04iLCJwYXJzZSIsImUiLCJzdGF0dXNDb2RlIiwiY29uc29sZSIsIndhcm4iLCJQYXJzZUNsb3VkIiwiQ2xvdWQiLCJnbG9iYWwiLCJrZXlzIiwiZGVmYXVsdHMiLCJmb3JFYWNoIiwia2V5IiwiaGFzT3duUHJvcGVydHkiLCJ1c2VyU2Vuc2l0aXZlRmllbGRzIiwiQXJyYXkiLCJmcm9tIiwiU2V0IiwibWFzdGVyS2V5SXBzIiwic29ja2V0cyIsInNvY2tldCIsInNvY2tldElkIiwicmVtb3RlQWRkcmVzcyIsInJlbW90ZVBvcnQiLCJkZXN0cm95QWxpdmVDb25uZWN0aW9ucyIsImRlc3Ryb3kiLCJzdGRvdXQiLCJjbG9zZSJdLCJtYXBwaW5ncyI6Ijs7Ozs7O0FBU0E7O0FBRUE7Ozs7QUFDQTs7SUFBWUEsTzs7QUFDWjs7OztBQUNBOzs7O0FBQ0E7Ozs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFDQTs7QUFFQTs7QUFDQTs7SUFBWUMsVzs7Ozs7O0FBdkNaOztBQUVBLElBQUlDLFFBQVFDLFFBQVEsU0FBUixDQUFaO0FBQUEsSUFDRUMsYUFBYUQsUUFBUSxhQUFSLENBRGY7QUFBQSxJQUVFRSxVQUFVRixRQUFRLFNBQVIsQ0FGWjtBQUFBLElBR0VHLGNBQWNILFFBQVEsZUFBUixDQUhoQjtBQUFBLElBSUVJLFFBQVFKLFFBQVEsWUFBUixFQUFzQkksS0FKaEM7QUFBQSxJQUtFQyxPQUFPTCxRQUFRLE1BQVIsQ0FMVDs7QUFzQ0E7QUFDQU07O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxNQUFNQyxXQUFOLENBQWtCO0FBQ2hCOzs7O0FBSUFDLGNBQVlDLE9BQVosRUFBeUM7QUFDdkNDLG1CQUFlRCxPQUFmO0FBQ0EsVUFBTTtBQUNKRSxjQUFRLGlDQUFrQiw0QkFBbEIsQ0FESjtBQUVKQyxrQkFBWSxpQ0FBa0Is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QztBQUM5QixVQUFJO0FBQ0ZBLGdCQUFRRSxRQUFSLEVBQWtCSSxPQUFsQjtBQUNELE9BRkQsQ0FFRSxPQUFPdkIsQ0FBUCxFQUFVLENBQUUsS0FBTztBQUN0QjtBQUNGLEdBTkQ7O0FBUUEsUUFBTWxGLGlCQUFpQixZQUFXO0FBQ2hDUCxZQUFRaUgsTUFBUixDQUFlakYsS0FBZixDQUFxQiw2Q0FBckI7QUFDQStFO0FBQ0ExQyxXQUFPNkMsS0FBUDtBQUNBcEMsZ0JBQVl2RSxjQUFaO0FBQ0QsR0FMRDtBQU1BUCxVQUFRNEIsRUFBUixDQUFXLFNBQVgsRUFBc0JyQixjQUF0QjtBQUNBUCxVQUFRNEIsRUFBUixDQUFXLFFBQVgsRUFBcUJyQixjQUFyQjtBQUNEOztrQkFFY2hDLFciLCJmaWxlIjoiUGFyc2VTZXJ2ZXIuanMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBQYXJzZVNlcnZlciAtIG9wZW4tc291cmNlIGNvbXBhdGlibGUgQVBJIFNlcnZlciBmb3IgUGFyc2UgYXBwc1xuXG52YXIgYmF0Y2ggPSByZXF1aXJlKCcuL2JhdGNoJyksXG4gIGJvZHlQYXJzZXIgPSByZXF1aXJlKCdib2R5LXBhcnNlcicpLFxuICBleHByZXNzID0gcmVxdWlyZSgnZXhwcmVzcycpLFxuICBtaWRkbGV3YXJlcyA9IHJlcXVpcmUoJy4vbWlkZGxld2FyZXMnKSxcbiAgUGFyc2UgPSByZXF1aXJlKCdwYXJzZS9ub2RlJykuUGFyc2UsXG4gIHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmltcG9ydCB7IFBhcnNlU2VydmVyT3B0aW9ucyxcbiAgTGl2ZVF1ZXJ5U2VydmVyT3B0aW9ucyB9ICAgICAgZnJvbSAnLi9PcHRpb25zJztcbmltcG9ydCBkZWZhdWx0cyAgICAgICAgICAgICAgICAgZnJvbSAnLi9kZWZhdWx0cyc7XG5pbXBvcnQgKiBhcyBsb2dnaW5nICAgICAgICAgICAgIGZyb20gJy4vbG9nZ2VyJztcbmltcG9ydCBDb25maWcgICAgICAgICAgICAgICAgICAgZnJvbSAnLi9Db25maWcnO1xuaW1wb3J0IFByb21pc2VSb3V0ZXIgICAgICAgICAgICBmcm9tICcuL1Byb21pc2VSb3V0ZXInO1xuaW1wb3J0IHJlcXVpcmVkUGFyYW1ldGVyICAgICAgICBmcm9tICcuL3JlcXVpcmVkUGFyYW1ldGVyJztcbmltcG9ydCB7IEFuYWx5dGljc1JvdXRlciB9ICAgICAgZnJvbSAnLi9Sb3V0ZXJzL0FuYWx5dGljc1JvdXRlcic7XG5pbXBvcnQgeyBDbGFzc2VzUm91dGVyIH0gICAgICAgIGZyb20gJy4vUm91dGVycy9DbGFzc2VzUm91dGVyJztcbmltcG9ydCB7IEZlYXR1cmVzUm91dGVyIH0gICAgICAgZnJvbSAnLi9Sb3V0ZXJzL0ZlYXR1cmVzUm91dGVyJztcbmltcG9ydCB7IEZpbGVzUm91dGVyIH0gICAgICAgICAgZnJvbSAnLi9Sb3V0ZXJzL0ZpbGVzUm91dGVyJztcbmltcG9ydCB7IEZ1bmN0aW9uc1JvdXRlciB9ICAgICAgZnJvbSAnLi9Sb3V0ZXJzL0Z1bmN0aW9uc1JvdXRlcic7XG5pbXBvcnQgeyBHbG9iYWxDb25maWdSb3V0ZXIgfSAgIGZyb20gJy4vUm91dGVycy9HbG9iYWxDb25maWdSb3V0ZXInO1xuaW1wb3J0IHsgSG9va3NSb3V0ZXIgfSAgICAgICAgICBmcm9tICcuL1JvdXRlcnMvSG9va3NSb3V0ZXInO1xuaW1wb3J0IHsgSUFQVmFsaWRhdGlvblJvdXRlciB9ICBmcm9tICcuL1JvdXRlcnMvSUFQVmFsaWRhdGlvblJvdXRlcic7XG5pbXBvcnQgeyBJbnN0YWxsYXRpb25zUm91dGVyIH0gIGZyb20gJy4vUm91dGVycy9JbnN0YWxsYXRpb25zUm91dGVyJztcbmltcG9ydCB7IExvZ3NSb3V0ZXIgfSAgICAgICAgICAgZnJvbSAnLi9Sb3V0ZXJzL0xvZ3NSb3V0ZXInO1xuaW1wb3J0IHsgUGFyc2VMaXZlUXVlcnlTZXJ2ZXIgfSBmcm9tICcuL0xpdmVRdWVyeS9QYXJzZUxpdmVRdWVyeVNlcnZlcic7XG5pbXBvcnQgeyBQdWJsaWNBUElSb3V0ZXIgfSAgICAgIGZyb20gJy4vUm91dGVycy9QdWJsaWNBUElSb3V0ZXInO1xuaW1wb3J0IHsgUHVzaFJvdXRlciB9ICAgICAgICAgICBmcm9tICcuL1JvdXRlcnMvUHVzaFJvdXRlcic7XG5pbXBvcnQgeyBDbG91ZENvZGVSb3V0ZXIgfSAgICAgIGZyb20gJy4vUm91dGVycy9DbG91ZENvZGVSb3V0ZXInO1xuaW1wb3J0IHsgUm9sZXNSb3V0ZXIgfSAgICAgICAgICBmcm9tICcuL1JvdXRlcnMvUm9sZXNSb3V0ZXInO1xuaW1wb3J0IHsgU2NoZW1hc1JvdXRlciB9ICAgICAgICBmcm9tICcuL1JvdXRlcnMvU2NoZW1hc1JvdXRlcic7XG5pbXBvcnQgeyBTZXNzaW9uc1JvdXRlciB9ICAgICAgIGZyb20gJy4vUm91dGVycy9TZXNzaW9uc1JvdXRlcic7XG5pbXBvcnQgeyBVc2Vyc1JvdXRlciB9ICAgICAgICAgIGZyb20gJy4vUm91dGVycy9Vc2Vyc1JvdXRlcic7XG5pbXBvcnQgeyBQdXJnZVJvdXRlciB9ICAgICAgICAgIGZyb20gJy4vUm91dGVycy9QdXJnZVJvdXRlcic7XG5pbXBvcnQgeyBBdWRpZW5jZXNSb3V0ZXIgfSAgICAgIGZyb20gJy4vUm91dGVycy9BdWRpZW5jZXNSb3V0ZXInO1xuaW1wb3J0IHsgQWdncmVnYXRlUm91dGVyIH0gICAgICBmcm9tICcuL1JvdXRlcnMvQWdncmVnYXRlUm91dGVyJztcblxuaW1wb3J0IHsgUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlciB9IGZyb20gJy4vUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlcic7XG5pbXBvcnQgKiBhcyBjb250cm9sbGVycyBmcm9tICcuL0NvbnRyb2xsZXJzJztcbi8vIE11dGF0ZSB0aGUgUGFyc2Ugb2JqZWN0IHRvIGFkZCB0aGUgQ2xvdWQgQ29kZSBoYW5kbGVyc1xuYWRkUGFyc2VDbG91ZCgpO1xuXG4vLyBQYXJzZVNlcnZlciB3b3JrcyBsaWtlIGEgY29uc3RydWN0b3Igb2YgYW4gZXhwcmVzcyBhcHAuXG4vLyBUaGUgYXJncyB0aGF0IHdlIHVuZGVyc3RhbmQgYXJlOlxuLy8gXCJhbmFseXRpY3NBZGFwdGVyXCI6IGFuIGFkYXB0ZXIgY2xhc3MgZm9yIGFuYWx5dGljc1xuLy8gXCJmaWxlc0FkYXB0ZXJcIjogYSBjbGFzcyBsaWtlIEdyaWRTdG9yZUFkYXB0ZXIgcHJvdmlkaW5nIGNyZWF0ZSwgZ2V0LFxuLy8gICAgICAgICAgICAgICAgIGFuZCBkZWxldGVcbi8vIFwibG9nZ2VyQWRhcHRlclwiOiBhIGNsYXNzIGxpa2UgV2luc3RvbkxvZ2dlckFkYXB0ZXIgcHJvdmlkaW5nIGluZm8sIGVycm9yLFxuLy8gICAgICAgICAgICAgICAgIGFuZCBxdWVyeVxuLy8gXCJqc29uTG9nc1wiOiBsb2cgYXMgc3RydWN0dXJlZCBKU09OIG9iamVjdHNcbi8vIFwiZGF0YWJhc2VVUklcIjogYSB1cmkgbGlrZSBtb25nb2RiOi8vbG9jYWxob3N0OjI3MDE3L2RibmFtZSB0byB0ZWxsIHVzXG4vLyAgICAgICAgICB3aGF0IGRhdGFiYXNlIHRoaXMgUGFyc2UgQVBJIGNvbm5lY3RzIHRvLlxuLy8gXCJjbG91ZFwiOiByZWxhdGl2ZSBsb2NhdGlvbiB0byBjbG91ZCBjb2RlIHRvIHJlcXVpcmUsIG9yIGEgZnVuY3Rpb25cbi8vICAgICAgICAgIHRoYXQgaXMgZ2l2ZW4gYW4gaW5zdGFuY2Ugb2YgUGFyc2UgYXMgYSBwYXJhbWV0ZXIuICBVc2UgdGhpcyBpbnN0YW5jZSBvZiBQYXJzZVxuLy8gICAgICAgICAgdG8gcmVnaXN0ZXIgeW91ciBjbG91ZCBjb2RlIGhvb2tzIGFuZCBmdW5jdGlvbnMuXG4vLyBcImFwcElkXCI6IHRoZSBhcHBsaWNhdGlvbiBpZCB0byBob3N0XG4vLyBcIm1hc3RlcktleVwiOiB0aGUgbWFzdGVyIGtleSBmb3IgcmVxdWVzdHMgdG8gdGhpcyBhcHBcbi8vIFwiY29sbGVjdGlvblByZWZpeFwiOiBvcHRpb25hbCBwcmVmaXggZm9yIGRhdGFiYXNlIGNvbGxlY3Rpb24gbmFtZXNcbi8vIFwiZmlsZUtleVwiOiBvcHRpb25hbCBrZXkgZnJvbSBQYXJzZSBkYXNoYm9hcmQgZm9yIHN1cHBvcnRpbmcgb2xkZXIgZmlsZXNcbi8vICAgICAgICAgICAgaG9zdGVkIGJ5IFBhcnNlXG4vLyBcImNsaWVudEtleVwiOiBvcHRpb25hbCBrZXkgZnJvbSBQYXJzZSBkYXNoYm9hcmRcbi8vIFwiZG90TmV0S2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZFxuLy8gXCJyZXN0QVBJS2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZFxuLy8gXCJ3ZWJob29rS2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZFxuLy8gXCJqYXZhc2NyaXB0S2V5XCI6IG9wdGlvbmFsIGtleSBmcm9tIFBhcnNlIGRhc2hib2FyZFxuLy8gXCJwdXNoXCI6IG9wdGlvbmFsIGtleSBmcm9tIGNvbmZpZ3VyZSBwdXNoXG4vLyBcInNlc3Npb25MZW5ndGhcIjogb3B0aW9uYWwgbGVuZ3RoIGluIHNlY29uZHMgZm9yIGhvdyBsb25nIFNlc3Npb25zIHNob3VsZCBiZSB2YWxpZCBmb3Jcbi8vIFwibWF4TGltaXRcIjogb3B0aW9uYWwgdXBwZXIgYm91bmQgZm9yIHdoYXQgY2FuIGJlIHNwZWNpZmllZCBmb3IgdGhlICdsaW1pdCcgcGFyYW1ldGVyIG9uIHF1ZXJpZXNcblxuY2xhc3MgUGFyc2VTZXJ2ZXIge1xuICAvKipcbiAgICogQGNvbnN0cnVjdG9yXG4gICAqIEBwYXJhbSB7UGFyc2VTZXJ2ZXJPcHRpb25zfSBvcHRpb25zIHRoZSBwYXJzZSBzZXJ2ZXIgaW5pdGlhbGl6YXRpb24gb3B0aW9uc1xuICAqL1xuICBjb25zdHJ1Y3RvcihvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgICBpbmplY3REZWZhdWx0cyhvcHRpb25zKTtcbiAgICBjb25zdCB7XG4gICAgICBhcHBJZCA9IHJlcXVpcmVkUGFyYW1ldGVyKCdZb3UgbXVzdCBwcm92aWRlIGFuIGFwcElkIScpLFxuICAgICAgbWFzdGVyS2V5ID0gcmVxdWlyZWRQYXJhbWV0ZXIoJ1lvdSBtdXN0IHByb3ZpZGUgYSBtYXN0ZXJLZXkhJyksXG4gICAgICBjbG91ZCxcbiAgICAgIGphdmFzY3JpcHRLZXksXG4gICAgICBzZXJ2ZXJVUkwgPSByZXF1aXJlZFBhcmFtZXRlcignWW91IG11c3QgcHJvdmlkZSBhIHNlcnZlclVSTCEnKSxcbiAgICAgIF9faW5kZXhCdWlsZENvbXBsZXRpb25DYWxsYmFja0ZvclRlc3RzID0gKCkgPT4ge30sXG4gICAgfSA9IG9wdGlvbnM7XG4gICAgLy8gSW5pdGlhbGl6ZSB0aGUgbm9kZSBjbGllbnQgU0RLIGF1dG9tYXRpY2FsbHlcbiAgICBQYXJzZS5pbml0aWFsaXplKGFwcElkLCBqYXZhc2NyaXB0S2V5IHx8ICd1bnVzZWQnLCBtYXN0ZXJLZXkpO1xuICAgIFBhcnNlLnNlcnZlclVSTCA9IHNlcnZlclVSTDtcblxuICAgIGNvbnN0IGFsbENvbnRyb2xsZXJzID0gY29udHJvbGxlcnMuZ2V0Q29udHJvbGxlcnMob3B0aW9ucyk7XG5cbiAgICBjb25zdCB7XG4gICAgICBsb2dnZXJDb250cm9sbGVyLFxuICAgICAgZGF0YWJhc2VDb250cm9sbGVyLFxuICAgICAgaG9va3NDb250cm9sbGVyLFxuICAgIH0gPSBhbGxDb250cm9sbGVycztcbiAgICB0aGlzLmNvbmZpZyA9IENvbmZpZy5wdXQoT2JqZWN0LmFzc2lnbih7fSwgb3B0aW9ucywgYWxsQ29udHJvbGxlcnMpKTtcblxuICAgIGxvZ2dpbmcuc2V0TG9nZ2VyKGxvZ2dlckNvbnRyb2xsZXIpO1xuICAgIGNvbnN0IGRiSW5pdFByb21pc2UgPSBkYXRhYmFzZUNvbnRyb2xsZXIucGVyZm9ybUluaXRpYWxpemF0aW9uKCk7XG4gICAgaG9va3NDb250cm9sbGVyLmxvYWQoKTtcblxuICAgIC8vIE5vdGU6IFRlc3RzIHdpbGwgc3RhcnQgdG8gZmFpbCBpZiBhbnkgdmFsaWRhdGlvbiBoYXBwZW5zIGFmdGVyIHRoaXMgaXMgY2FsbGVkLlxuICAgIGlmIChwcm9jZXNzLmVudi5URVNUSU5HKSB7XG4gICAgICBfX2luZGV4QnVpbGRDb21wbGV0aW9uQ2FsbGJhY2tGb3JUZXN0cyhkYkluaXRQcm9taXNlKTtcbiAgICB9XG5cbiAgICBpZiAoY2xvdWQpIHtcbiAgICAgIGFkZFBhcnNlQ2xvdWQoKTtcbiAgICAgIGlmICh0eXBlb2YgY2xvdWQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgY2xvdWQoUGFyc2UpXG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBjbG91ZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgcmVxdWlyZShwYXRoLnJlc29sdmUocHJvY2Vzcy5jd2QoKSwgY2xvdWQpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IFwiYXJndW1lbnQgJ2Nsb3VkJyBtdXN0IGVpdGhlciBiZSBhIHN0cmluZyBvciBhIGZ1bmN0aW9uXCI7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgZ2V0IGFwcCgpIHtcbiAgICBpZiAoIXRoaXMuX2FwcCkge1xuICAgICAgdGhpcy5fYXBwID0gUGFyc2VTZXJ2ZXIuYXBwKHRoaXMuY29uZmlnKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX2FwcDtcbiAgfVxuXG4gIGhhbmRsZVNodXRkb3duKCkge1xuICAgIGNvbnN0IHsgYWRhcHRlciB9ID0gdGhpcy5jb25maWcuZGF0YWJhc2VDb250cm9sbGVyO1xuICAgIGlmIChhZGFwdGVyICYmIHR5cGVvZiBhZGFwdGVyLmhhbmRsZVNodXRkb3duID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBhZGFwdGVyLmhhbmRsZVNodXRkb3duKCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzdGF0aWNcbiAgICogQ3JlYXRlIGFuIGV4cHJlc3MgYXBwIGZvciB0aGUgcGFyc2Ugc2VydmVyXG4gICAqIEBwYXJhbSB7T2JqZWN0fSBvcHRpb25zIGxldCB5b3Ugc3BlY2lmeSB0aGUgbWF4VXBsb2FkU2l6ZSB3aGVuIGNyZWF0aW5nIHRoZSBleHByZXNzIGFwcCAgKi9cbiAgc3RhdGljIGFwcCh7bWF4VXBsb2FkU2l6ZSA9ICcyMG1iJywgYXBwSWR9KSB7XG4gICAgLy8gVGhpcyBhcHAgc2VydmVzIHRoZSBQYXJzZSBBUEkgZGlyZWN0bHkuXG4gICAgLy8gSXQncyB0aGUgZXF1aXZhbGVudCBvZiBodHRwczovL2FwaS5wYXJzZS5jb20vMSBpbiB0aGUgaG9zdGVkIFBhcnNlIEFQSS5cbiAgICB2YXIgYXBpID0gZXhwcmVzcygpO1xuICAgIC8vYXBpLnVzZShcIi9hcHBzXCIsIGV4cHJlc3Muc3RhdGljKF9fZGlybmFtZSArIFwiL3B1YmxpY1wiKSk7XG4gICAgLy8gRmlsZSBoYW5kbGluZyBuZWVkcyB0byBiZSBiZWZvcmUgZGVmYXVsdCBtaWRkbGV3YXJlcyBhcmUgYXBwbGllZFxuICAgIGFwaS51c2UoJy8nLCBtaWRkbGV3YXJlcy5hbGxvd0Nyb3NzRG9tYWluLCBuZXcgRmlsZXNSb3V0ZXIoKS5leHByZXNzUm91dGVyKHtcbiAgICAgIG1heFVwbG9hZFNpemU6IG1heFVwbG9hZFNpemVcbiAgICB9KSk7XG5cbiAgICBhcGkudXNlKCcvaGVhbHRoJywgKGZ1bmN0aW9uKHJlcSwgcmVzKSB7XG4gICAgICByZXMuanNvbih7XG4gICAgICAgIHN0YXR1czogJ29rJ1xuICAgICAgfSk7XG4gICAgfSkpO1xuXG4gICAgYXBpLnVzZSgnLycsIGJvZHlQYXJzZXIudXJsZW5jb2RlZCh7ZXh0ZW5kZWQ6IGZhbHNlfSksIG5ldyBQdWJsaWNBUElSb3V0ZXIoKS5leHByZXNzUm91dGVyKCkpO1xuXG4gICAgYXBpLnVzZShib2R5UGFyc2VyLmpzb24oeyAndHlwZSc6ICcqLyonICwgbGltaXQ6IG1heFVwbG9hZFNpemUgfSkpO1xuICAgIGFwaS51c2UobWlkZGxld2FyZXMuYWxsb3dDcm9zc0RvbWFpbik7XG4gICAgYXBpLnVzZShtaWRkbGV3YXJlcy5hbGxvd01ldGhvZE92ZXJyaWRlKTtcbiAgICBhcGkudXNlKG1pZGRsZXdhcmVzLmhhbmRsZVBhcnNlSGVhZGVycyk7XG5cbiAgICBjb25zdCBhcHBSb3V0ZXIgPSBQYXJzZVNlcnZlci5wcm9taXNlUm91dGVyKHsgYXBwSWQgfSk7XG4gICAgYXBpLnVzZShhcHBSb3V0ZXIuZXhwcmVzc1JvdXRlcigpKTtcblxuICAgIGFwaS51c2UobWlkZGxld2FyZXMuaGFuZGxlUGFyc2VFcnJvcnMpO1xuXG4gICAgLy8gcnVuIHRoZSBmb2xsb3dpbmcgd2hlbiBub3QgdGVzdGluZ1xuICAgIGlmICghcHJvY2Vzcy5lbnYuVEVTVElORykge1xuICAgICAgLy9UaGlzIGNhdXNlcyB0ZXN0cyB0byBzcGV3IHNvbWUgdXNlbGVzcyB3YXJuaW5ncywgc28gZGlzYWJsZSBpbiB0ZXN0XG4gICAgICAvKiBpc3RhbmJ1bCBpZ25vcmUgbmV4dCAqL1xuICAgICAgcHJvY2Vzcy5vbigndW5jYXVnaHRFeGNlcHRpb24nLCAoZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gXCJFQUREUklOVVNFXCIpIHsgLy8gdXNlci1mcmllbmRseSBtZXNzYWdlIGZvciB0aGlzIGNvbW1vbiBlcnJvclxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBVbmFibGUgdG8gbGlzdGVuIG9uIHBvcnQgJHtlcnIucG9ydH0uIFRoZSBwb3J0IGlzIGFscmVhZHkgaW4gdXNlLmApO1xuICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgLy8gdmVyaWZ5IHRoZSBzZXJ2ZXIgdXJsIGFmdGVyIGEgJ21vdW50JyBldmVudCBpcyByZWNlaXZlZFxuICAgICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICAgIGFwaS5vbignbW91bnQnLCBmdW5jdGlvbigpIHtcbiAgICAgICAgUGFyc2VTZXJ2ZXIudmVyaWZ5U2VydmVyVXJsKCk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKHByb2Nlc3MuZW52LlBBUlNFX1NFUlZFUl9FTkFCTEVfRVhQRVJJTUVOVEFMX0RJUkVDVF9BQ0NFU1MgPT09ICcxJykge1xuICAgICAgUGFyc2UuQ29yZU1hbmFnZXIuc2V0UkVTVENvbnRyb2xsZXIoUGFyc2VTZXJ2ZXJSRVNUQ29udHJvbGxlcihhcHBJZCwgYXBwUm91dGVyKSk7XG4gICAgfVxuICAgIHJldHVybiBhcGk7XG4gIH1cblxuICBzdGF0aWMgcHJvbWlzZVJvdXRlcih7YXBwSWR9KSB7XG4gICAgY29uc3Qgcm91dGVycyA9IFtcbiAgICAgIG5ldyBDbGFzc2VzUm91dGVyKCksXG4gICAgICBuZXcgVXNlcnNSb3V0ZXIoKSxcbiAgICAgIG5ldyBTZXNzaW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFJvbGVzUm91dGVyKCksXG4gICAgICBuZXcgQW5hbHl0aWNzUm91dGVyKCksXG4gICAgICBuZXcgSW5zdGFsbGF0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IEZ1bmN0aW9uc1JvdXRlcigpLFxuICAgICAgbmV3IFNjaGVtYXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBQdXNoUm91dGVyKCksXG4gICAgICBuZXcgTG9nc1JvdXRlcigpLFxuICAgICAgbmV3IElBUFZhbGlkYXRpb25Sb3V0ZXIoKSxcbiAgICAgIG5ldyBGZWF0dXJlc1JvdXRlcigpLFxuICAgICAgbmV3IEdsb2JhbENvbmZpZ1JvdXRlcigpLFxuICAgICAgbmV3IFB1cmdlUm91dGVyKCksXG4gICAgICBuZXcgSG9va3NSb3V0ZXIoKSxcbiAgICAgIG5ldyBDbG91ZENvZGVSb3V0ZXIoKSxcbiAgICAgIG5ldyBBdWRpZW5jZXNSb3V0ZXIoKSxcbiAgICAgIG5ldyBBZ2dyZWdhdGVSb3V0ZXIoKVxuICAgIF07XG5cbiAgICBjb25zdCByb3V0ZXMgPSByb3V0ZXJzLnJlZHVjZSgobWVtbywgcm91dGVyKSA9PiB7XG4gICAgICByZXR1cm4gbWVtby5jb25jYXQocm91dGVyLnJvdXRlcyk7XG4gICAgfSwgW10pO1xuXG4gICAgY29uc3QgYXBwUm91dGVyID0gbmV3IFByb21pc2VSb3V0ZXIocm91dGVzLCBhcHBJZCk7XG5cbiAgICBiYXRjaC5tb3VudE9udG8oYXBwUm91dGVyKTtcbiAgICByZXR1cm4gYXBwUm91dGVyO1xuICB9XG5cbiAgLyoqXG4gICAqIHN0YXJ0cyB0aGUgcGFyc2Ugc2VydmVyJ3MgZXhwcmVzcyBhcHBcbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdG8gdXNlIHRvIHN0YXJ0IHRoZSBzZXJ2ZXJcbiAgICogQHBhcmFtIHtGdW5jdGlvbn0gY2FsbGJhY2sgY2FsbGVkIHdoZW4gdGhlIHNlcnZlciBoYXMgc3RhcnRlZFxuICAgKiBAcmV0dXJucyB7UGFyc2VTZXJ2ZXJ9IHRoZSBwYXJzZSBzZXJ2ZXIgaW5zdGFuY2VcbiAgICovXG4gIHN0YXJ0KG9wdGlvbnM6IFBhcnNlU2VydmVyT3B0aW9ucywgY2FsbGJhY2s6ID8oKT0+dm9pZCkge1xuICAgIGNvbnN0IGFwcCA9IGV4cHJlc3MoKTtcbiAgICBpZiAob3B0aW9ucy5taWRkbGV3YXJlKSB7XG4gICAgICBsZXQgbWlkZGxld2FyZTtcbiAgICAgIGlmICh0eXBlb2Ygb3B0aW9ucy5taWRkbGV3YXJlID09ICdzdHJpbmcnKSB7XG4gICAgICAgIG1pZGRsZXdhcmUgPSByZXF1aXJlKHBhdGgucmVzb2x2ZShwcm9jZXNzLmN3ZCgpLCBvcHRpb25zLm1pZGRsZXdhcmUpKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG1pZGRsZXdhcmUgPSBvcHRpb25zLm1pZGRsZXdhcmU7IC8vIHVzZSBhcy1pcyBsZXQgZXhwcmVzcyBmYWlsXG4gICAgICB9XG4gICAgICBhcHAudXNlKG1pZGRsZXdhcmUpO1xuICAgIH1cblxuICAgIGFwcC51c2Uob3B0aW9ucy5tb3VudFBhdGgsIHRoaXMuYXBwKTtcbiAgICBjb25zdCBzZXJ2ZXIgPSBhcHAubGlzdGVuKG9wdGlvbnMucG9ydCwgb3B0aW9ucy5ob3N0LCBjYWxsYmFjayk7XG4gICAgdGhpcy5zZXJ2ZXIgPSBzZXJ2ZXI7XG5cbiAgICBpZiAob3B0aW9ucy5zdGFydExpdmVRdWVyeVNlcnZlciB8fCBvcHRpb25zLmxpdmVRdWVyeVNlcnZlck9wdGlvbnMpIHtcbiAgICAgIHRoaXMubGl2ZVF1ZXJ5U2VydmVyID0gUGFyc2VTZXJ2ZXIuY3JlYXRlTGl2ZVF1ZXJ5U2VydmVyKHNlcnZlciwgb3B0aW9ucy5saXZlUXVlcnlTZXJ2ZXJPcHRpb25zKTtcbiAgICB9XG4gICAgLyogaXN0YW5idWwgaWdub3JlIG5leHQgKi9cbiAgICBpZiAoIXByb2Nlc3MuZW52LlRFU1RJTkcpIHtcbiAgICAgIGNvbmZpZ3VyZUxpc3RlbmVycyh0aGlzKTtcbiAgICB9XG4gICAgdGhpcy5leHByZXNzQXBwID0gYXBwO1xuICAgIHJldHVybiB0aGlzO1xuICB9XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBuZXcgUGFyc2VTZXJ2ZXIgYW5kIHN0YXJ0cyBpdC5cbiAgICogQHBhcmFtIHtQYXJzZVNlcnZlck9wdGlvbnN9IG9wdGlvbnMgdXNlZCB0byBzdGFydCB0aGUgc2VydmVyXG4gICAqIEBwYXJhbSB7RnVuY3Rpb259IGNhbGxiYWNrIGNhbGxlZCB3aGVuIHRoZSBzZXJ2ZXIgaGFzIHN0YXJ0ZWRcbiAgICogQHJldHVybnMge1BhcnNlU2VydmVyfSB0aGUgcGFyc2Ugc2VydmVyIGluc3RhbmNlXG4gICAqL1xuICBzdGF0aWMgc3RhcnQob3B0aW9uczogUGFyc2VTZXJ2ZXJPcHRpb25zLCBjYWxsYmFjazogPygpPT52b2lkKSB7XG4gICAgY29uc3QgcGFyc2VTZXJ2ZXIgPSBuZXcgUGFyc2VTZXJ2ZXIob3B0aW9ucyk7XG4gICAgcmV0dXJuIHBhcnNlU2VydmVyLnN0YXJ0KG9wdGlvbnMsIGNhbGxiYWNrKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIZWxwZXIgbWV0aG9kIHRvIGNyZWF0ZSBhIGxpdmVRdWVyeSBzZXJ2ZXJcbiAgICogQHN0YXRpY1xuICAgKiBAcGFyYW0ge1NlcnZlcn0gaHR0cFNlcnZlciBhbiBvcHRpb25hbCBodHRwIHNlcnZlciB0byBwYXNzXG4gICAqIEBwYXJhbSB7TGl2ZVF1ZXJ5U2VydmVyT3B0aW9uc30gY29uZmlnIG9wdGlvbnMgZm90IGhlIGxpdmVRdWVyeVNlcnZlclxuICAgKiBAcmV0dXJucyB7UGFyc2VMaXZlUXVlcnlTZXJ2ZXJ9IHRoZSBsaXZlIHF1ZXJ5IHNlcnZlciBpbnN0YW5jZVxuICAgKi9cbiAgc3RhdGljIGNyZWF0ZUxpdmVRdWVyeVNlcnZlcihodHRwU2VydmVyLCBjb25maWc6IExpdmVRdWVyeVNlcnZlck9wdGlvbnMpIHtcbiAgICBpZiAoIWh0dHBTZXJ2ZXIgfHwgKGNvbmZpZyAmJiBjb25maWcucG9ydCkpIHtcbiAgICAgIHZhciBhcHAgPSBleHByZXNzKCk7XG4gICAgICBodHRwU2VydmVyID0gcmVxdWlyZSgnaHR0cCcpLmNyZWF0ZVNlcnZlcihhcHApO1xuICAgICAgaHR0cFNlcnZlci5saXN0ZW4oY29uZmlnLnBvcnQpO1xuICAgIH1cbiAgICByZXR1cm4gbmV3IFBhcnNlTGl2ZVF1ZXJ5U2VydmVyKGh0dHBTZXJ2ZXIsIGNvbmZpZyk7XG4gIH1cblxuICBzdGF0aWMgdmVyaWZ5U2VydmVyVXJsKGNhbGxiYWNrKSB7XG4gICAgLy8gcGVyZm9ybSBhIGhlYWx0aCBjaGVjayBvbiB0aGUgc2VydmVyVVJMIHZhbHVlXG4gICAgaWYoUGFyc2Uuc2VydmVyVVJMKSB7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gcmVxdWlyZSgncmVxdWVzdCcpO1xuICAgICAgcmVxdWVzdChQYXJzZS5zZXJ2ZXJVUkwucmVwbGFjZSgvXFwvJC8sIFwiXCIpICsgXCIvaGVhbHRoXCIsIGZ1bmN0aW9uIChlcnJvciwgcmVzcG9uc2UsIGJvZHkpIHtcbiAgICAgICAgbGV0IGpzb247XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAganNvbiA9IEpTT04ucGFyc2UoYm9keSk7XG4gICAgICAgIH0gY2F0Y2goZSkge1xuICAgICAgICAgIGpzb24gPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGlmIChlcnJvciB8fCByZXNwb25zZS5zdGF0dXNDb2RlICE9PSAyMDAgfHwgIWpzb24gfHwganNvbiAmJiBqc29uLnN0YXR1cyAhPT0gJ29rJykge1xuICAgICAgICAgIC8qIGVzbGludC1kaXNhYmxlIG5vLWNvbnNvbGUgKi9cbiAgICAgICAgICBjb25zb2xlLndhcm4oYFxcbldBUk5JTkcsIFVuYWJsZSB0byBjb25uZWN0IHRvICcke1BhcnNlLnNlcnZlclVSTH0nLmAgK1xuICAgICAgICAgICAgYCBDbG91ZCBjb2RlIGFuZCBwdXNoIG5vdGlmaWNhdGlvbnMgbWF5IGJlIHVuYXZhaWxhYmxlIVxcbmApO1xuICAgICAgICAgIC8qIGVzbGludC1lbmFibGUgbm8tY29uc29sZSAqL1xuICAgICAgICAgIGlmKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhmYWxzZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGlmKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBjYWxsYmFjayh0cnVlKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhZGRQYXJzZUNsb3VkKCkge1xuICBjb25zdCBQYXJzZUNsb3VkID0gcmVxdWlyZShcIi4vY2xvdWQtY29kZS9QYXJzZS5DbG91ZFwiKTtcbiAgT2JqZWN0LmFzc2lnbihQYXJzZS5DbG91ZCwgUGFyc2VDbG91ZCk7XG4gIGdsb2JhbC5QYXJzZSA9IFBhcnNlO1xufVxuXG5mdW5jdGlvbiBpbmplY3REZWZhdWx0cyhvcHRpb25zOiBQYXJzZVNlcnZlck9wdGlvbnMpIHtcbiAgT2JqZWN0LmtleXMoZGVmYXVsdHMpLmZvckVhY2goKGtleSkgPT4ge1xuICAgIGlmICghb3B0aW9ucy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICBvcHRpb25zW2tleV0gPSBkZWZhdWx0c1trZXldO1xuICAgIH1cbiAgfSk7XG5cbiAgaWYgKCFvcHRpb25zLmhhc093blByb3BlcnR5KCdzZXJ2ZXJVUkwnKSkge1xuICAgIG9wdGlvbnMuc2VydmVyVVJMID0gYGh0dHA6Ly9sb2NhbGhvc3Q6JHtvcHRpb25zLnBvcnR9JHtvcHRpb25zLm1vdW50UGF0aH1gO1xuICB9XG5cbiAgb3B0aW9ucy51c2VyU2Vuc2l0aXZlRmllbGRzID0gQXJyYXkuZnJvbShuZXcgU2V0KG9wdGlvbnMudXNlclNlbnNpdGl2ZUZpZWxkcy5jb25jYXQoXG4gICAgZGVmYXVsdHMudXNlclNlbnNpdGl2ZUZpZWxkcyxcbiAgICBvcHRpb25zLnVzZXJTZW5zaXRpdmVGaWVsZHNcbiAgKSkpO1xuXG4gIG9wdGlvbnMubWFzdGVyS2V5SXBzID0gQXJyYXkuZnJvbShuZXcgU2V0KG9wdGlvbnMubWFzdGVyS2V5SXBzLmNvbmNhdChcbiAgICBkZWZhdWx0cy5tYXN0ZXJLZXlJcHMsXG4gICAgb3B0aW9ucy5tYXN0ZXJLZXlJcHNcbiAgKSkpO1xufVxuXG4vLyBUaG9zZSBjYW4ndCBiZSB0ZXN0ZWQgYXMgaXQgcmVxdWlyZXMgYSBzdWJwcm9jZXNzXG4vKiBpc3RhbmJ1bCBpZ25vcmUgbmV4dCAqL1xuZnVuY3Rpb24gY29uZmlndXJlTGlzdGVuZXJzKHBhcnNlU2VydmVyKSB7XG4gIGNvbnN0IHNlcnZlciA9IHBhcnNlU2VydmVyLnNlcnZlcjtcbiAgY29uc3Qgc29ja2V0cyA9IHt9O1xuICAvKiBDdXJyZW50bHksIGV4cHJlc3MgZG9lc24ndCBzaHV0IGRvd24gaW1tZWRpYXRlbHkgYWZ0ZXIgcmVjZWl2aW5nIFNJR0lOVC9TSUdURVJNIGlmIGl0IGhhcyBjbGllbnQgY29ubmVjdGlvbnMgdGhhdCBoYXZlbid0IHRpbWVkIG91dC4gKFRoaXMgaXMgYSBrbm93biBpc3N1ZSB3aXRoIG5vZGUgLSBodHRwczovL2dpdGh1Yi5jb20vbm9kZWpzL25vZGUvaXNzdWVzLzI2NDIpXG4gICAgVGhpcyBmdW5jdGlvbiwgYWxvbmcgd2l0aCBgZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMoKWAsIGludGVuZCB0byBmaXggdGhpcyBiZWhhdmlvciBzdWNoIHRoYXQgcGFyc2Ugc2VydmVyIHdpbGwgY2xvc2UgYWxsIG9wZW4gY29ubmVjdGlvbnMgYW5kIGluaXRpYXRlIHRoZSBzaHV0ZG93biBwcm9jZXNzIGFzIHNvb24gYXMgaXQgcmVjZWl2ZXMgYSBTSUdJTlQvU0lHVEVSTSBzaWduYWwuICovXG4gIHNlcnZlci5vbignY29ubmVjdGlvbicsIChzb2NrZXQpID0+IHtcbiAgICBjb25zdCBzb2NrZXRJZCA9IHNvY2tldC5yZW1vdGVBZGRyZXNzICsgJzonICsgc29ja2V0LnJlbW90ZVBvcnQ7XG4gICAgc29ja2V0c1tzb2NrZXRJZF0gPSBzb2NrZXQ7XG4gICAgc29ja2V0Lm9uKCdjbG9zZScsICgpID0+IHtcbiAgICAgIGRlbGV0ZSBzb2NrZXRzW3NvY2tldElkXTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgY29uc3QgZGVzdHJveUFsaXZlQ29ubmVjdGlvbnMgPSBmdW5jdGlvbigpIHtcbiAgICBmb3IgKGNvbnN0IHNvY2tldElkIGluIHNvY2tldHMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNvY2tldHNbc29ja2V0SWRdLmRlc3Ryb3koKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHsgLyogKi8gfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGhhbmRsZVNodXRkb3duID0gZnVuY3Rpb24oKSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoJ1Rlcm1pbmF0aW9uIHNpZ25hbCByZWNlaXZlZC4gU2h1dHRpbmcgZG93bi4nKTtcbiAgICBkZXN0cm95QWxpdmVDb25uZWN0aW9ucygpO1xuICAgIHNlcnZlci5jbG9zZSgpO1xuICAgIHBhcnNlU2VydmVyLmhhbmRsZVNodXRkb3duKCk7XG4gIH07XG4gIHByb2Nlc3Mub24oJ1NJR1RFUk0nLCBoYW5kbGVTaHV0ZG93bik7XG4gIHByb2Nlc3Mub24oJ1NJR0lOVCcsIGhhbmRsZVNodXRkb3duKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgUGFyc2VTZXJ2ZXI7XG4iXX0=