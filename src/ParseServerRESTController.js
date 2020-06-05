const AWSXRay = require('hulab-xray-sdk');
const Config = require('./Config');
const Auth = require('./Auth');
const RESTController = require('parse/lib/node/RESTController');
const URL = require('url');
const Parse = require('parse/node');

function getSessionToken(options) {
  if (options && typeof options.sessionToken === 'string') {
    return Promise.resolve(options.sessionToken);
  }
  return Promise.resolve(null);
}

function getAuth(options = {}, config) {
  const installationId = options.installationId || 'cloud';
  if (options.useMasterKey) {
    return Promise.resolve(
      new Auth.Auth({ config, isMaster: true, installationId })
    );
  }
  return getSessionToken(options).then(sessionToken => {
    if (sessionToken) {
      options.sessionToken = sessionToken;
      return Auth.getAuthForSessionToken({
        config,
        sessionToken: sessionToken,
        installationId,
      });
    } else {
      return Promise.resolve(new Auth.Auth({ config, installationId }));
    }
  });
}

function ParseServerRESTController(applicationId, router) {
  function handleRequest(method, path, data = {}, options = {}, config) {
    // Store the arguments, for later use if internal fails
    const args = arguments;

    if (!config) {
      config = Config.get(applicationId);
    }
    const serverURL = URL.parse(config.serverURL);
    if (path.indexOf(serverURL.path) === 0) {
      path = path.slice(serverURL.path.length, path.length);
    }

    if (path[0] !== '/') {
      path = '/' + path;
    }

    if (path === '/batch') {
      let initialPromise = Promise.resolve();
      if (data.transaction === true) {
        initialPromise = config.database.createTransactionalSession();
      }
      return initialPromise.then(() => {
        const promises = data.requests.map(request => {
          return handleRequest(
            request.method,
            request.path,
            request.body,
            options,
            config
          ).then(
            response => {
              return { success: response };
            },
            error => {
              return {
                error: { code: error.code, error: error.message },
              };
            }
          );
        });
        return Promise.all(promises).then(result => {
          if (data.transaction === true) {
            if (
              result.find(resultItem => typeof resultItem.error === 'object')
            ) {
              return config.database.abortTransactionalSession().then(() => {
                return Promise.reject(result);
              });
            } else {
              return config.database.commitTransactionalSession().then(() => {
                return result;
              });
            }
          } else {
            return result;
          }
        });
      });
    }

    let query;
    if (method === 'GET') {
      query = data;
    }

    return new Promise((resolve, reject) => {
      tracePromise('getAuth', getAuth(options, config)).then(auth => {
        const request = {
          body: data,
          config,
          auth,
          info: {
            applicationId: applicationId,
            sessionToken: options.sessionToken,
          },
          query,
        };
        return Promise.resolve()
          .then(() => {
            return router.tryRouteRequest(method, path, request);
          })
          .then(
            response => {
              resolve(response.response, response.status, response);
            },
            err => {
              if (
                err instanceof Parse.Error &&
                err.code == Parse.Error.INVALID_JSON &&
                err.message == `cannot route ${method} ${path}`
              ) {
                RESTController.request.apply(null, args).then(resolve, reject);
              } else {
                reject(err);
              }
            }
          );
      }, reject);
    });
  }

  return {
    request: handleRequest,
    ajax: RESTController.ajax,
  };
}

function tracePromise(operation, promise = Promise.resolve()) {
  // Temporary removing trace here
  return promise;
  // const parent = AWSXRay.getSegment();
  // if (!parent) {
  //   return promise;
  // }
  // return new Promise((resolve, reject) => {
  //   AWSXRay.captureAsyncFunc(
  //     `Parse-Server_RESTController_${operation}`,
  //     subsegment => {
  //       subsegment &&
  //         subsegment.addAnnotation('Controller', 'ParseServerRESTController');
  //       subsegment && subsegment.addAnnotation('Operation', operation);
  //       (promise instanceof Promise ? promise : Promise.resolve(promise)).then(
  //         function(result) {
  //           resolve(result);
  //           subsegment && subsegment.close();
  //         },
  //         function(error) {
  //           reject(error);
  //           subsegment && subsegment.close(error);
  //         }
  //       );
  //     }
  //   );
  // });
}

export default ParseServerRESTController;
export { ParseServerRESTController };
