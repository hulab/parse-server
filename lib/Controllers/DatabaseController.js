"use strict";

var _node = require("parse/node");

var _lodash = _interopRequireDefault(require("lodash"));

var _intersect = _interopRequireDefault(require("intersect"));

var _deepcopy = _interopRequireDefault(require("deepcopy"));

var _logger = _interopRequireDefault(require("../logger"));

var SchemaController = _interopRequireWildcard(require("./SchemaController"));

var _StorageAdapter = require("../Adapters/Storage/StorageAdapter");

var _hulabXraySdk = _interopRequireDefault(require("hulab-xray-sdk"));

function _getRequireWildcardCache() { if (typeof WeakMap !== "function") return null; var cache = new WeakMap(); _getRequireWildcardCache = function () { return cache; }; return cache; }

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } if (obj === null || typeof obj !== "object" && typeof obj !== "function") { return { default: obj }; } var cache = _getRequireWildcardCache(); if (cache && cache.has(obj)) { return cache.get(obj); } var newObj = {}; var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor; for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) { var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null; if (desc && (desc.get || desc.set)) { Object.defineProperty(newObj, key, desc); } else { newObj[key] = obj[key]; } } } newObj.default = obj; if (cache) { cache.set(obj, newObj); } return newObj; }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(Object(source), true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(Object(source)).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

function _objectWithoutProperties(source, excluded) { if (source == null) return {}; var target = _objectWithoutPropertiesLoose(source, excluded); var key, i; if (Object.getOwnPropertySymbols) { var sourceSymbolKeys = Object.getOwnPropertySymbols(source); for (i = 0; i < sourceSymbolKeys.length; i++) { key = sourceSymbolKeys[i]; if (excluded.indexOf(key) >= 0) continue; if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue; target[key] = source[key]; } } return target; }

function _objectWithoutPropertiesLoose(source, excluded) { if (source == null) return {}; var target = {}; var sourceKeys = Object.keys(source); var key, i; for (i = 0; i < sourceKeys.length; i++) { key = sourceKeys[i]; if (excluded.indexOf(key) >= 0) continue; target[key] = source[key]; } return target; }

function addWriteACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_wperm' query, we don't allow client queries on that, no need to $and


  newQuery._wperm = {
    $in: [null, ...acl]
  };
  return newQuery;
}

function addReadACL(query, acl) {
  const newQuery = _lodash.default.cloneDeep(query); //Can't be any existing '_rperm' query, we don't allow client queries on that, no need to $and


  newQuery._rperm = {
    $in: [null, '*', ...acl]
  };
  return newQuery;
} // Transforms a REST API formatted ACL object to our two-field mongo format.


const transformObjectACL = (_ref) => {
  let {
    ACL
  } = _ref,
      result = _objectWithoutProperties(_ref, ["ACL"]);

  if (!ACL) {
    return result;
  }

  result._wperm = [];
  result._rperm = [];

  for (const entry in ACL) {
    if (ACL[entry].read) {
      result._rperm.push(entry);
    }

    if (ACL[entry].write) {
      result._wperm.push(entry);
    }
  }

  return result;
};

const specialQuerykeys = ['$and', '$or', '$nor', '_rperm', '_wperm', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count'];

const isSpecialQueryKey = key => {
  return specialQuerykeys.indexOf(key) >= 0;
};

const validateQuery = query => {
  if (query.ACL) {
    throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Cannot query on ACL.');
  }

  if (query.$or) {
    if (query.$or instanceof Array) {
      query.$or.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $or format - use an array value.');
    }
  }

  if (query.$and) {
    if (query.$and instanceof Array) {
      query.$and.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $and format - use an array value.');
    }
  }

  if (query.$nor) {
    if (query.$nor instanceof Array && query.$nor.length > 0) {
      query.$nor.forEach(validateQuery);
    } else {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, 'Bad $nor format - use an array of at least 1 value.');
    }
  }

  Object.keys(query).forEach(key => {
    if (query && query[key] && query[key].$regex) {
      if (typeof query[key].$options === 'string') {
        if (!query[key].$options.match(/^[imxs]+$/)) {
          throw new _node.Parse.Error(_node.Parse.Error.INVALID_QUERY, `Bad $options value for query: ${query[key].$options}`);
        }
      }
    }

    if (!isSpecialQueryKey(key) && !key.match(/^[a-zA-Z][a-zA-Z0-9_\.]*$/)) {
      throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${key}`);
    }
  });
}; // Filters out any data that shouldn't be on this REST-formatted object.


const filterSensitiveData = (isMaster, aclGroup, auth, operation, schema, className, protectedFields, object) => {
  let userId = null;
  if (auth && auth.user) userId = auth.user.id; // replace protectedFields when using pointer-permissions

  const perms = schema.getClassLevelPermissions(className);

  if (perms) {
    const isReadOperation = ['get', 'find'].indexOf(operation) > -1;

    if (isReadOperation && perms.protectedFields) {
      // extract protectedFields added with the pointer-permission prefix
      const protectedFieldsPointerPerm = Object.keys(perms.protectedFields).filter(key => key.startsWith('userField:')).map(key => {
        return {
          key: key.substring(10),
          value: perms.protectedFields[key]
        };
      });
      const newProtectedFields = [];
      let overrideProtectedFields = false; // check if the object grants the current user access based on the extracted fields

      protectedFieldsPointerPerm.forEach(pointerPerm => {
        let pointerPermIncludesUser = false;
        const readUserFieldValue = object[pointerPerm.key];

        if (readUserFieldValue) {
          if (Array.isArray(readUserFieldValue)) {
            pointerPermIncludesUser = readUserFieldValue.some(user => user.objectId && user.objectId === userId);
          } else {
            pointerPermIncludesUser = readUserFieldValue.objectId && readUserFieldValue.objectId === userId;
          }
        }

        if (pointerPermIncludesUser) {
          overrideProtectedFields = true;
          newProtectedFields.push(pointerPerm.value);
        }
      }); // if at least one pointer-permission affected the current user
      // intersect vs protectedFields from previous stage (@see addProtectedFields)
      // Sets theory (intersections): A x (B x C) == (A x B) x C

      if (overrideProtectedFields && protectedFields) {
        newProtectedFields.push(protectedFields);
      } // intersect all sets of protectedFields


      newProtectedFields.forEach(fields => {
        if (fields) {
          // if there're no protctedFields by other criteria ( id / role / auth)
          // then we must intersect each set (per userField)
          if (!protectedFields) {
            protectedFields = fields;
          } else {
            protectedFields = protectedFields.filter(v => fields.includes(v));
          }
        }
      });
    }
  }

  const isUserClass = className === '_User';
  /* special treat for the user class: don't filter protectedFields if currently loggedin user is
  the retrieved user */

  if (!(isUserClass && userId && object.objectId === userId)) {
    protectedFields && protectedFields.forEach(k => delete object[k]); // fields not requested by client (excluded),
    //but were needed to apply protecttedFields

    perms.protectedFields && perms.protectedFields.temporaryKeys && perms.protectedFields.temporaryKeys.forEach(k => delete object[k]);
  }

  if (!isUserClass) {
    return object;
  }

  object.password = object._hashed_password;
  delete object._hashed_password;
  delete object.sessionToken;

  if (isMaster) {
    return object;
  }

  delete object._email_verify_token;
  delete object._perishable_token;
  delete object._perishable_token_expires_at;
  delete object._tombstone;
  delete object._email_verify_token_expires_at;
  delete object._failed_login_count;
  delete object._account_lockout_expires_at;
  delete object._password_changed_at;
  delete object._password_history;

  if (aclGroup.indexOf(object.objectId) > -1) {
    return object;
  }

  delete object.authData;
  return object;
};

// Runs an update on the database.
// Returns a promise for an object with the new values for field
// modifications that don't know their results ahead of time, like
// 'increment'.
// Options:
//   acl:  a list of strings. If the object to be updated has an ACL,
//         one of the provided strings must provide the caller with
//         write permissions.
const specialKeysForUpdate = ['_hashed_password', '_perishable_token', '_email_verify_token', '_email_verify_token_expires_at', '_account_lockout_expires_at', '_failed_login_count', '_perishable_token_expires_at', '_password_changed_at', '_password_history'];

const isSpecialUpdateKey = key => {
  return specialKeysForUpdate.indexOf(key) >= 0;
};

function expandResultOnKeyPath(object, key, value) {
  if (key.indexOf('.') < 0) {
    object[key] = value[key];
    return object;
  }

  const path = key.split('.');
  const firstKey = path[0];
  const nextPath = path.slice(1).join('.');
  object[firstKey] = expandResultOnKeyPath(object[firstKey] || {}, nextPath, value[firstKey]);
  delete object[key];
  return object;
}

function sanitizeDatabaseResult(originalObject, result) {
  const response = {};

  if (!result) {
    return Promise.resolve(response);
  }

  Object.keys(originalObject).forEach(key => {
    const keyUpdate = originalObject[key]; // determine if that was an op

    if (keyUpdate && typeof keyUpdate === 'object' && keyUpdate.__op && ['Add', 'AddUnique', 'Remove', 'Increment'].indexOf(keyUpdate.__op) > -1) {
      // only valid ops that produce an actionable result
      // the op may have happend on a keypath
      expandResultOnKeyPath(response, key, result);
    }
  });
  return Promise.resolve(response);
}

function joinTableName(className, key) {
  return `_Join:${key}:${className}`;
}

const flattenUpdateOperatorsForCreate = object => {
  for (const key in object) {
    if (object[key] && object[key].__op) {
      switch (object[key].__op) {
        case 'Increment':
          if (typeof object[key].amount !== 'number') {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].amount;
          break;

        case 'Add':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'AddUnique':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = object[key].objects;
          break;

        case 'Remove':
          if (!(object[key].objects instanceof Array)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_JSON, 'objects to add must be an array');
          }

          object[key] = [];
          break;

        case 'Delete':
          delete object[key];
          break;

        default:
          throw new _node.Parse.Error(_node.Parse.Error.COMMAND_UNAVAILABLE, `The ${object[key].__op} operator is not supported yet.`);
      }
    }
  }
};

const transformAuthData = (className, object, schema) => {
  if (object.authData && className === '_User') {
    Object.keys(object.authData).forEach(provider => {
      const providerData = object.authData[provider];
      const fieldName = `_auth_data_${provider}`;

      if (providerData == null) {
        object[fieldName] = {
          __op: 'Delete'
        };
      } else {
        object[fieldName] = providerData;
        schema.fields[fieldName] = {
          type: 'Object'
        };
      }
    });
    delete object.authData;
  }
}; // Transforms a Database format ACL to a REST API format ACL


const untransformObjectACL = (_ref2) => {
  let {
    _rperm,
    _wperm
  } = _ref2,
      output = _objectWithoutProperties(_ref2, ["_rperm", "_wperm"]);

  if (_rperm || _wperm) {
    output.ACL = {};

    (_rperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          read: true
        };
      } else {
        output.ACL[entry]['read'] = true;
      }
    });

    (_wperm || []).forEach(entry => {
      if (!output.ACL[entry]) {
        output.ACL[entry] = {
          write: true
        };
      } else {
        output.ACL[entry]['write'] = true;
      }
    });
  }

  return output;
};
/**
 * When querying, the fieldName may be compound, extract the root fieldName
 *     `temperature.celsius` becomes `temperature`
 * @param {string} fieldName that may be a compound field name
 * @returns {string} the root name of the field
 */


const getRootFieldName = fieldName => {
  return fieldName.split('.')[0];
};

const relationSchema = {
  fields: {
    relatedId: {
      type: 'String'
    },
    owningId: {
      type: 'String'
    }
  }
};

class DatabaseController {
  constructor(adapter, schemaCache) {
    this.adapter = adapter;
    this.schemaCache = schemaCache; // We don't want a mutable this.schema, because then you could have
    // one request that uses different schemas for different parts of
    // it. Instead, use loadSchema to get a schema.

    this.schemaPromise = null;
    this._transactionalSession = null;
  }

  collectionExists(className) {
    return this.adapter.classExists(className);
  }

  purgeCollection(className) {
    return this.loadSchema().then(schemaController => schemaController.getOneSchema(className)).then(schema => this.adapter.deleteObjectsByQuery(className, schema, {}));
  }

  validateClassName(className) {
    if (!SchemaController.classNameIsValid(className)) {
      return Promise.reject(new _node.Parse.Error(_node.Parse.Error.INVALID_CLASS_NAME, 'invalid className: ' + className));
    }

    return Promise.resolve();
  } // Returns a promise for a schemaController.


  loadSchema(options = {
    clearCache: false
  }) {
    if (this.schemaPromise != null) {
      return this.schemaPromise;
    }

    this.schemaPromise = SchemaController.load(this.adapter, this.schemaCache, options);
    this.schemaPromise.then(() => delete this.schemaPromise, () => delete this.schemaPromise);
    return this.loadSchema(options);
  }

  loadSchemaIfNeeded(schemaController, options = {
    clearCache: false
  }) {
    return schemaController ? Promise.resolve(schemaController) : this.loadSchema(options);
  } // Returns a promise for the classname that is related to the given
  // classname through the key.
  // TODO: make this not in the DatabaseController interface


  redirectClassNameForKey(className, key) {
    return this.loadSchema().then(schema => {
      var t = schema.getExpectedType(className, key);

      if (t != null && typeof t !== 'string' && t.type === 'Relation') {
        return t.targetClass;
      }

      return className;
    });
  } // Uses the schema to validate the object (REST API format).
  // Returns a promise that resolves to the new schema.
  // This does not update this.schema, because in a situation like a
  // batch request, that could confuse other users of the schema.


  validateObject(className, object, query, runOptions) {
    let schema;
    const acl = runOptions.acl;
    const isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchema().then(s => {
      schema = s;

      if (isMaster) {
        return Promise.resolve();
      }

      return this.canAddField(schema, className, object, aclGroup, runOptions);
    }).then(() => {
      return schema.validateObject(className, object, query);
    });
  }

  update(className, query, update, {
    acl,
    many,
    upsert,
    addsField
  } = {}, skipSanitization = false, validateOnly = false, validSchemaController) {
    const originalQuery = query;
    const originalUpdate = update; // Make a copy of the object, so we don't mutate the incoming data.

    update = (0, _deepcopy.default)(update);
    var relationUpdates = [];
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'update')).then(() => {
        relationUpdates = this.collectRelationUpdates(className, originalQuery.objectId, update);

        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'update', query, aclGroup);

          if (addsField) {
            query = {
              $and: [query, this.addPointerPermissions(schemaController, className, 'addField', query, aclGroup)]
            };
          }
        }

        if (!query) {
          return Promise.resolve();
        }

        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query);
        return schemaController.getOneSchema(className, true).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(schema => {
          Object.keys(update).forEach(fieldName => {
            if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }

            const rootFieldName = getRootFieldName(fieldName);

            if (!SchemaController.fieldNameIsValid(rootFieldName) && !isSpecialUpdateKey(rootFieldName)) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name for update: ${fieldName}`);
            }
          });

          for (const updateOperation in update) {
            if (update[updateOperation] && typeof update[updateOperation] === 'object' && Object.keys(update[updateOperation]).some(innerKey => innerKey.includes('$') || innerKey.includes('.'))) {
              throw new _node.Parse.Error(_node.Parse.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
            }
          }

          update = transformObjectACL(update);
          transformAuthData(className, update, schema);

          if (validateOnly) {
            return this.adapter.find(className, schema, query, {}).then(result => {
              if (!result || !result.length) {
                throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
              }

              return {};
            });
          }

          if (many) {
            return this.adapter.updateObjectsByQuery(className, schema, query, update, this._transactionalSession);
          } else if (upsert) {
            return this.adapter.upsertOneObject(className, schema, query, update, this._transactionalSession);
          } else {
            return this.adapter.findOneAndUpdate(className, schema, query, update, this._transactionalSession);
          }
        });
      }).then(result => {
        if (!result) {
          throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
        }

        if (validateOnly) {
          return result;
        }

        return this.handleRelationUpdates(className, originalQuery.objectId, update, relationUpdates).then(() => {
          return result;
        });
      }).then(result => {
        if (skipSanitization) {
          return Promise.resolve(result);
        }

        return sanitizeDatabaseResult(originalUpdate, result);
      });
    });
  } // Collect all relation-updating operations from a REST-format update.
  // Returns a list of all relation updates to perform
  // This mutates update.


  collectRelationUpdates(className, objectId, update) {
    var ops = [];
    var deleteMe = [];
    objectId = update.objectId || objectId;

    var process = (op, key) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'RemoveRelation') {
        ops.push({
          key,
          op
        });
        deleteMe.push(key);
      }

      if (op.__op == 'Batch') {
        for (var x of op.ops) {
          process(x, key);
        }
      }
    };

    for (const key in update) {
      process(update[key], key);
    }

    for (const key of deleteMe) {
      delete update[key];
    }

    return ops;
  } // Processes relation-updating operations from a REST-format update.
  // Returns a promise that resolves when all updates have been performed


  handleRelationUpdates(className, objectId, update, ops) {
    var pending = [];
    objectId = update.objectId || objectId;
    ops.forEach(({
      key,
      op
    }) => {
      if (!op) {
        return;
      }

      if (op.__op == 'AddRelation') {
        for (const object of op.objects) {
          pending.push(this.addRelation(key, className, objectId, object.objectId));
        }
      }

      if (op.__op == 'RemoveRelation') {
        for (const object of op.objects) {
          pending.push(this.removeRelation(key, className, objectId, object.objectId));
        }
      }
    });
    return Promise.all(pending);
  } // Adds a relation.
  // Returns a promise that resolves successfully iff the add was successful.


  addRelation(key, fromClassName, fromId, toId) {
    const doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.upsertOneObject(`_Join:${key}:${fromClassName}`, relationSchema, doc, doc, this._transactionalSession);
  } // Removes a relation.
  // Returns a promise that resolves successfully iff the remove was
  // successful.


  removeRelation(key, fromClassName, fromId, toId) {
    var doc = {
      relatedId: toId,
      owningId: fromId
    };
    return this.adapter.deleteObjectsByQuery(`_Join:${key}:${fromClassName}`, relationSchema, doc, this._transactionalSession).catch(error => {
      // We don't care if they try to delete a non-existent relation.
      if (error.code == _node.Parse.Error.OBJECT_NOT_FOUND) {
        return;
      }

      throw error;
    });
  } // Removes objects matches this query from the database.
  // Returns a promise that resolves successfully iff the object was
  // deleted.
  // Options:
  //   acl:  a list of strings. If the object to be updated has an ACL,
  //         one of the provided strings must provide the caller with
  //         write permissions.


  destroy(className, query, {
    acl
  } = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    return this.loadSchemaIfNeeded(validSchemaController).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'delete')).then(() => {
        if (!isMaster) {
          query = this.addPointerPermissions(schemaController, className, 'delete', query, aclGroup);

          if (!query) {
            throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
          }
        } // delete by query


        if (acl) {
          query = addWriteACL(query, acl);
        }

        validateQuery(query);
        return schemaController.getOneSchema(className).catch(error => {
          // If the schema doesn't exist, pretend it exists with no fields. This behavior
          // will likely need revisiting.
          if (error === undefined) {
            return {
              fields: {}
            };
          }

          throw error;
        }).then(parseFormatSchema => this.adapter.deleteObjectsByQuery(className, parseFormatSchema, query, this._transactionalSession)).catch(error => {
          // When deleting sessions while changing passwords, don't throw an error if they don't have any sessions.
          if (className === '_Session' && error.code === _node.Parse.Error.OBJECT_NOT_FOUND) {
            return Promise.resolve({});
          }

          throw error;
        });
      });
    });
  } // Inserts an object into the database.
  // Returns a promise that resolves successfully iff the object saved.


  create(className, object, {
    acl
  } = {}, validateOnly = false, validSchemaController) {
    // Make a copy of the object, so we don't mutate the incoming data.
    const originalObject = object;
    object = transformObjectACL(object);
    object.createdAt = {
      iso: object.createdAt,
      __type: 'Date'
    };
    object.updatedAt = {
      iso: object.updatedAt,
      __type: 'Date'
    };
    var isMaster = acl === undefined;
    var aclGroup = acl || [];
    const relationUpdates = this.collectRelationUpdates(className, null, object);
    return this.validateClassName(className).then(() => this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      return (isMaster ? Promise.resolve() : schemaController.validatePermission(className, aclGroup, 'create')).then(() => schemaController.enforceClassExists(className)).then(() => schemaController.getOneSchema(className, true)).then(schema => {
        transformAuthData(className, object, schema);
        flattenUpdateOperatorsForCreate(object);

        if (validateOnly) {
          return {};
        }

        return this.adapter.createObject(className, SchemaController.convertSchemaToAdapterSchema(schema), object, this._transactionalSession);
      }).then(result => {
        if (validateOnly) {
          return originalObject;
        }

        return this.handleRelationUpdates(className, object.objectId, object, relationUpdates).then(() => {
          return sanitizeDatabaseResult(originalObject, result.ops[0]);
        });
      });
    });
  }

  canAddField(schema, className, object, aclGroup, runOptions) {
    const classSchema = schema.schemaData[className];

    if (!classSchema) {
      return Promise.resolve();
    }

    const fields = Object.keys(object);
    const schemaFields = Object.keys(classSchema.fields);
    const newKeys = fields.filter(field => {
      // Skip fields that are unset
      if (object[field] && object[field].__op && object[field].__op === 'Delete') {
        return false;
      }

      return schemaFields.indexOf(field) < 0;
    });

    if (newKeys.length > 0) {
      // adds a marker that new field is being adding during update
      runOptions.addsField = true;
      const action = runOptions.action;
      return schema.validatePermission(className, aclGroup, 'addField', action);
    }

    return Promise.resolve();
  } // Won't delete collections in the system namespace

  /**
   * Delete all classes and clears the schema cache
   *
   * @param {boolean} fast set to true if it's ok to just delete rows and not indexes
   * @returns {Promise<void>} when the deletions completes
   */


  deleteEverything(fast = false) {
    this.schemaPromise = null;
    return Promise.all([this.adapter.deleteAllClasses(fast), this.schemaCache.clear()]);
  } // Returns a promise for a list of related ids given an owning id.
  // className here is the owning className.


  relatedIds(className, key, owningId, queryOptions) {
    const {
      skip,
      limit,
      sort
    } = queryOptions;
    const findOptions = {};

    if (sort && sort.createdAt && this.adapter.canSortOnJoinTables) {
      findOptions.sort = {
        _id: sort.createdAt
      };
      findOptions.limit = limit;
      findOptions.skip = skip;
      queryOptions.skip = 0;
    }

    return this.adapter.find(joinTableName(className, key), relationSchema, {
      owningId
    }, findOptions).then(results => results.map(result => result.relatedId));
  } // Returns a promise for a list of owning ids given some related ids.
  // className here is the owning className.


  owningIds(className, key, relatedIds) {
    return this.adapter.find(joinTableName(className, key), relationSchema, {
      relatedId: {
        $in: relatedIds
      }
    }, {}).then(results => results.map(result => result.owningId));
  } // Modifies query so that it no longer has $in on relation fields, or
  // equal-to-pointer constraints on relation fields.
  // Returns a promise that resolves when query is mutated


  reduceInRelation(className, query, schema) {
    // Search for an in-relation or equal-to-relation
    // Make it sequential for now, not sure of paralleization side effects
    if (query['$or']) {
      const ors = query['$or'];
      return Promise.all(ors.map((aQuery, index) => {
        return this.reduceInRelation(className, aQuery, schema).then(aQuery => {
          query['$or'][index] = aQuery;
        });
      })).then(() => {
        return Promise.resolve(query);
      });
    }

    const promises = Object.keys(query).map(key => {
      const t = schema.getExpectedType(className, key);

      if (!t || t.type !== 'Relation') {
        return Promise.resolve(query);
      }

      let queries = null;

      if (query[key] && (query[key]['$in'] || query[key]['$ne'] || query[key]['$nin'] || query[key].__type == 'Pointer')) {
        // Build the list of queries
        queries = Object.keys(query[key]).map(constraintKey => {
          let relatedIds;
          let isNegation = false;

          if (constraintKey === 'objectId') {
            relatedIds = [query[key].objectId];
          } else if (constraintKey == '$in') {
            relatedIds = query[key]['$in'].map(r => r.objectId);
          } else if (constraintKey == '$nin') {
            isNegation = true;
            relatedIds = query[key]['$nin'].map(r => r.objectId);
          } else if (constraintKey == '$ne') {
            isNegation = true;
            relatedIds = [query[key]['$ne'].objectId];
          } else {
            return;
          }

          return {
            isNegation,
            relatedIds
          };
        });
      } else {
        queries = [{
          isNegation: false,
          relatedIds: []
        }];
      } // remove the current queryKey as we don,t need it anymore


      delete query[key]; // execute each query independently to build the list of
      // $in / $nin

      const promises = queries.map(q => {
        if (!q) {
          return Promise.resolve();
        }

        return this.owningIds(className, key, q.relatedIds).then(ids => {
          if (q.isNegation) {
            this.addNotInObjectIdsIds(ids, query);
          } else {
            this.addInObjectIdsIds(ids, query);
          }

          return Promise.resolve();
        });
      });
      return Promise.all(promises).then(() => {
        return Promise.resolve();
      });
    });
    return Promise.all(promises).then(() => {
      return Promise.resolve(query);
    });
  } // Modifies query so that it no longer has $relatedTo
  // Returns a promise that resolves when query is mutated


  reduceRelationKeys(className, query, queryOptions) {
    if (query['$or']) {
      return Promise.all(query['$or'].map(aQuery => {
        return this.reduceRelationKeys(className, aQuery, queryOptions);
      }));
    }

    var relatedTo = query['$relatedTo'];

    if (relatedTo) {
      return this.relatedIds(relatedTo.object.className, relatedTo.key, relatedTo.object.objectId, queryOptions).then(ids => {
        delete query['$relatedTo'];
        this.addInObjectIdsIds(ids, query);
        return this.reduceRelationKeys(className, query, queryOptions);
      }).then(() => {});
    }
  }

  addInObjectIdsIds(ids = null, query) {
    const idsFromString = typeof query.objectId === 'string' ? [query.objectId] : null;
    const idsFromEq = query.objectId && query.objectId['$eq'] ? [query.objectId['$eq']] : null;
    const idsFromIn = query.objectId && query.objectId['$in'] ? query.objectId['$in'] : null; // -disable-next

    const allIds = [idsFromString, idsFromEq, idsFromIn, ids].filter(list => list !== null);
    const totalLength = allIds.reduce((memo, list) => memo + list.length, 0);
    let idsIntersection = [];

    if (totalLength > 125) {
      idsIntersection = _intersect.default.big(allIds);
    } else {
      idsIntersection = (0, _intersect.default)(allIds);
    } // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.


    if (!('objectId' in query)) {
      query.objectId = {
        $in: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $in: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$in'] = idsIntersection;
    return query;
  }

  addNotInObjectIdsIds(ids = [], query) {
    const idsFromNin = query.objectId && query.objectId['$nin'] ? query.objectId['$nin'] : [];
    let allIds = [...idsFromNin, ...ids].filter(list => list !== null); // make a set and spread to remove duplicates

    allIds = [...new Set(allIds)]; // Need to make sure we don't clobber existing shorthand $eq constraints on objectId.

    if (!('objectId' in query)) {
      query.objectId = {
        $nin: undefined
      };
    } else if (typeof query.objectId === 'string') {
      query.objectId = {
        $nin: undefined,
        $eq: query.objectId
      };
    }

    query.objectId['$nin'] = allIds;
    return query;
  } // Runs a query on the database.
  // Returns a promise that resolves to a list of items.
  // Options:
  //   skip    number of results to skip.
  //   limit   limit to this number of results.
  //   sort    an object where keys are the fields to sort by.
  //           the value is +1 for ascending, -1 for descending.
  //   count   run a count instead of returning results.
  //   acl     restrict this operation with an ACL for the provided array
  //           of user objectIds and roles. acl: null means no user.
  //           when this field is not present, don't do anything regarding ACLs.
  //  caseInsensitive make string comparisons case insensitive
  // TODO: make userIds not needed here. The db adapter shouldn't know
  // anything about users, ideally. Then, improve the format of the ACL
  // arg to work like the others.


  find(className, query, {
    skip,
    limit,
    acl,
    sort = {},
    count,
    keys,
    op,
    distinct,
    pipeline,
    readPreference,
    hint,
    caseInsensitive = false,
    explain
  } = {}, auth = {}, validSchemaController) {
    const isMaster = acl === undefined;
    const aclGroup = acl || [];
    op = op || (typeof query.objectId == 'string' && Object.keys(query).length === 1 ? 'get' : 'find'); // Count operation if counting

    op = count === true ? 'count' : op;
    let classExists = true;
    return tracePromise('loadSchema', className, this.loadSchemaIfNeeded(validSchemaController)).then(schemaController => {
      //Allow volatile classes if querying with Master (for _PushStatus)
      //TODO: Move volatile classes concept into mongo adapter, postgres adapter shouldn't care
      //that api.parse.com breaks when _PushStatus exists in mongo.
      return tracePromise('getOneSchema', className, schemaController.getOneSchema(className, isMaster)).catch(error => {
        // Behavior for non-existent classes is kinda weird on Parse.com. Probably doesn't matter too much.
        // For now, pretend the class exists but has no objects,
        if (error === undefined) {
          classExists = false;
          return {
            fields: {}
          };
        }

        throw error;
      }).then(schema => {
        // Parse.com treats queries on _created_at and _updated_at as if they were queries on createdAt and updatedAt,
        // so duplicate that behavior here. If both are specified, the correct behavior to match Parse.com is to
        // use the one that appears first in the sort list.
        if (sort._created_at) {
          sort.createdAt = sort._created_at;
          delete sort._created_at;
        }

        if (sort._updated_at) {
          sort.updatedAt = sort._updated_at;
          delete sort._updated_at;
        }

        const queryOptions = {
          skip,
          limit,
          sort,
          keys,
          readPreference,
          hint,
          caseInsensitive,
          explain
        };
        Object.keys(sort).forEach(fieldName => {
          if (fieldName.match(/^authData\.([a-zA-Z0-9_]+)\.id$/)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Cannot sort by ${fieldName}`);
          }

          const rootFieldName = getRootFieldName(fieldName);

          if (!SchemaController.fieldNameIsValid(rootFieldName)) {
            throw new _node.Parse.Error(_node.Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}.`);
          }
        });
        return (isMaster ? Promise.resolve() : tracePromise('validatePermission', className, schemaController.validatePermission(className, aclGroup, op))).then(() => tracePromise('reduceRelationKeys', className, this.reduceRelationKeys(className, query, queryOptions))).then(() => tracePromise('reduceInRelation', className, this.reduceInRelation(className, query, schemaController))).then(() => {
          let protectedFields;

          if (!isMaster) {
            query = this.addPointerPermissions(schemaController, className, op, query, aclGroup);
            /* Don't use projections to optimize the protectedFields since the protectedFields
              based on pointer-permissions are determined after querying. The filtering can
              overwrite the protected fields. */

            protectedFields = this.addProtectedFields(schemaController, className, query, aclGroup, auth, queryOptions);
          }

          if (!query) {
            if (op === 'get') {
              throw new _node.Parse.Error(_node.Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
            } else {
              return [];
            }
          }

          if (!isMaster) {
            if (op === 'update' || op === 'delete') {
              query = addWriteACL(query, aclGroup);
            } else {
              query = addReadACL(query, aclGroup);
            }
          }

          validateQuery(query);

          if (count) {
            if (!classExists) {
              return 0;
            } else {
              return this.adapter.count(className, schema, query, readPreference, undefined, hint);
            }
          } else if (distinct) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.distinct(className, schema, query, distinct);
            }
          } else if (pipeline) {
            if (!classExists) {
              return [];
            } else {
              return this.adapter.aggregate(className, schema, pipeline, readPreference, hint, explain);
            }
          } else if (explain) {
            return this.adapter.find(className, schema, query, queryOptions);
          } else {
            return this.adapter.find(className, schema, query, queryOptions).then(objects => objects.map(object => {
              object = untransformObjectACL(object);
              return filterSensitiveData(isMaster, aclGroup, auth, op, schemaController, className, protectedFields, object);
            })).catch(error => {
              throw new _node.Parse.Error(_node.Parse.Error.INTERNAL_SERVER_ERROR, error);
            });
          }
        });
      });
    });
  }

  deleteSchema(className) {
    return this.loadSchema({
      clearCache: true
    }).then(schemaController => schemaController.getOneSchema(className, true)).catch(error => {
      if (error === undefined) {
        return {
          fields: {}
        };
      } else {
        throw error;
      }
    }).then(schema => {
      return this.collectionExists(className).then(() => this.adapter.count(className, {
        fields: {}
      }, null, '', false)).then(count => {
        if (count > 0) {
          throw new _node.Parse.Error(255, `Class ${className} is not empty, contains ${count} objects, cannot drop schema.`);
        }

        return this.adapter.deleteClass(className);
      }).then(wasParseCollection => {
        if (wasParseCollection) {
          const relationFieldNames = Object.keys(schema.fields).filter(fieldName => schema.fields[fieldName].type === 'Relation');
          return Promise.all(relationFieldNames.map(name => this.adapter.deleteClass(joinTableName(className, name)))).then(() => {
            return;
          });
        } else {
          return Promise.resolve();
        }
      });
    });
  } // Constraints query using CLP's pointer permissions (PP) if any.
  // 1. Etract the user id from caller's ACLgroup;
  // 2. Exctract a list of field names that are PP for target collection and operation;
  // 3. Constraint the original query so that each PP field must
  // point to caller's id (or contain it in case of PP field being an array)


  addPointerPermissions(schema, className, operation, query, aclGroup = []) {
    // Check if class has public permission for operation
    // If the BaseCLP pass, let go through
    if (schema.testPermissionsForClassName(className, aclGroup, operation)) {
      return query;
    }

    const perms = schema.getClassLevelPermissions(className);
    const userACL = aclGroup.filter(acl => {
      return acl.indexOf('role:') != 0 && acl != '*';
    });
    const groupKey = ['get', 'find', 'count'].indexOf(operation) > -1 ? 'readUserFields' : 'writeUserFields';
    const permFields = [];

    if (perms[operation] && perms[operation].pointerFields) {
      permFields.push(...perms[operation].pointerFields);
    }

    if (perms[groupKey]) {
      for (const field of perms[groupKey]) {
        if (!permFields.includes(field)) {
          permFields.push(field);
        }
      }
    } // the ACL should have exactly 1 user


    if (permFields.length > 0) {
      // the ACL should have exactly 1 user
      // No user set return undefined
      // If the length is > 1, that means we didn't de-dupe users correctly
      if (userACL.length != 1) {
        return;
      }

      const userId = userACL[0];
      const userPointer = {
        __type: 'Pointer',
        className: '_User',
        objectId: userId
      };
      const ors = permFields.flatMap(key => {
        // constraint for single pointer setup
        const q = {
          [key]: userPointer
        }; // constraint for users-array setup

        const qa = {
          [key]: {
            $all: [userPointer]
          }
        }; // if we already have a constraint on the key, use the $and

        if (Object.prototype.hasOwnProperty.call(query, key)) {
          return [{
            $and: [q, query]
          }, {
            $and: [qa, query]
          }];
        } // otherwise just add the constaint


        return [Object.assign({}, query, q), Object.assign({}, query, qa)];
      });
      return {
        $or: ors
      };
    } else {
      return query;
    }
  }

  addProtectedFields(schema, className, query = {}, aclGroup = [], auth = {}, queryOptions = {}) {
    const perms = schema.getClassLevelPermissions(className);
    if (!perms) return null;
    const protectedFields = perms.protectedFields;
    if (!protectedFields) return null;
    if (aclGroup.indexOf(query.objectId) > -1) return null; // for queries where "keys" are set and do not include all 'userField':{field},
    // we have to transparently include it, and then remove before returning to client
    // Because if such key not projected the permission won't be enforced properly
    // PS this is called when 'excludeKeys' already reduced to 'keys'

    const preserveKeys = queryOptions.keys; // these are keys that need to be included only
    // to be able to apply protectedFields by pointer
    // and then unset before returning to client (later in  filterSensitiveFields)

    const serverOnlyKeys = [];
    const authenticated = auth.user; // map to allow check without array search

    const roles = (auth.userRoles || []).reduce((acc, r) => {
      acc[r] = protectedFields[r];
      return acc;
    }, {}); // array of sets of protected fields. separate item for each applicable criteria

    const protectedKeysSets = [];

    for (const key in protectedFields) {
      // skip userFields
      if (key.startsWith('userField:')) {
        if (preserveKeys) {
          const fieldName = key.substring(10);

          if (!preserveKeys.includes(fieldName)) {
            // 1. put it there temporarily
            queryOptions.keys && queryOptions.keys.push(fieldName); // 2. preserve it delete later

            serverOnlyKeys.push(fieldName);
          }
        }

        continue;
      } // add public tier


      if (key === '*') {
        protectedKeysSets.push(protectedFields[key]);
        continue;
      }

      if (authenticated) {
        if (key === 'authenticated') {
          // for logged in users
          protectedKeysSets.push(protectedFields[key]);
          continue;
        }

        if (roles[key] && key.startsWith('role:')) {
          // add applicable roles
          protectedKeysSets.push(roles[key]);
        }
      }
    } // check if there's a rule for current user's id


    if (authenticated) {
      const userId = auth.user.id;

      if (perms.protectedFields[userId]) {
        protectedKeysSets.push(perms.protectedFields[userId]);
      }
    } // preserve fields to be removed before sending response to client


    if (serverOnlyKeys.length > 0) {
      perms.protectedFields.temporaryKeys = serverOnlyKeys;
    }

    let protectedKeys = protectedKeysSets.reduce((acc, next) => {
      if (next) {
        acc.push(...next);
      }

      return acc;
    }, []); // intersect all sets of protectedFields

    protectedKeysSets.forEach(fields => {
      if (fields) {
        protectedKeys = protectedKeys.filter(v => fields.includes(v));
      }
    });
    return protectedKeys;
  }

  createTransactionalSession() {
    return this.adapter.createTransactionalSession().then(transactionalSession => {
      this._transactionalSession = transactionalSession;
    });
  }

  commitTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to commit');
    }

    return this.adapter.commitTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  }

  abortTransactionalSession() {
    if (!this._transactionalSession) {
      throw new Error('There is no transactional session to abort');
    }

    return this.adapter.abortTransactionalSession(this._transactionalSession).then(() => {
      this._transactionalSession = null;
    });
  } // TODO: create indexes on first creation of a _User object. Otherwise it's impossible to
  // have a Parse app without it having a _User collection.


  performInitialization() {
    const requiredUserFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, {}, SchemaController.defaultColumns._User)
    };
    const requiredRoleFields = {
      fields: _objectSpread({}, SchemaController.defaultColumns._Default, {}, SchemaController.defaultColumns._Role)
    };
    const userClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_User'));
    const roleClassPromise = this.loadSchema().then(schema => schema.enforceClassExists('_Role'));
    const usernameUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['username'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for usernames: ', error);

      throw error;
    });
    const usernameCaseInsensitiveIndex = userClassPromise.then(() => this.adapter.ensureIndex('_User', requiredUserFields, ['username'], 'case_insensitive_username', true)).catch(error => {
      _logger.default.warn('Unable to create case insensitive username index: ', error);

      throw error;
    });
    const emailUniqueness = userClassPromise.then(() => this.adapter.ensureUniqueness('_User', requiredUserFields, ['email'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for user email addresses: ', error);

      throw error;
    });
    const emailCaseInsensitiveIndex = userClassPromise.then(() => this.adapter.ensureIndex('_User', requiredUserFields, ['email'], 'case_insensitive_email', true)).catch(error => {
      _logger.default.warn('Unable to create case insensitive email index: ', error);

      throw error;
    });
    const roleUniqueness = roleClassPromise.then(() => this.adapter.ensureUniqueness('_Role', requiredRoleFields, ['name'])).catch(error => {
      _logger.default.warn('Unable to ensure uniqueness for role name: ', error);

      throw error;
    });
    const indexPromise = this.adapter.updateSchemaWithIndexes(); // Create tables for volatile classes

    const adapterInit = this.adapter.performInitialization({
      VolatileClassesSchemas: SchemaController.VolatileClassesSchemas
    });
    return Promise.all([usernameUniqueness, usernameCaseInsensitiveIndex, emailUniqueness, emailCaseInsensitiveIndex, roleUniqueness, adapterInit, indexPromise]);
  }

}

function tracePromise(operation, className, promise = Promise.resolve()) {
  // Temporary removing trace here
  return promise; // const parent = AWSXRay.getSegment();
  // if (!parent) {
  //   return promise;
  // }
  // return new Promise((resolve, reject) => {
  //   AWSXRay.captureAsyncFunc(
  //     `Parse-Server_DatabaseCtrl_${operation}_${className}`,
  //     subsegment => {
  //       subsegment && subsegment.addAnnotation('Controller', 'DatabaseCtrl');
  //       subsegment && subsegment.addAnnotation('Operation', operation);
  //       className & subsegment &&
  //         subsegment.addAnnotation('ClassName', className);
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

module.exports = DatabaseController; // Expose validateQuery for tests

module.exports._validateQuery = validateQuery;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9Db250cm9sbGVycy9EYXRhYmFzZUNvbnRyb2xsZXIuanMiXSwibmFtZXMiOlsiYWRkV3JpdGVBQ0wiLCJxdWVyeSIsImFjbCIsIm5ld1F1ZXJ5IiwiXyIsImNsb25lRGVlcCIsIl93cGVybSIsIiRpbiIsImFkZFJlYWRBQ0wiLCJfcnBlcm0iLCJ0cmFuc2Zvcm1PYmplY3RBQ0wiLCJBQ0wiLCJyZXN1bHQiLCJlbnRyeSIsInJlYWQiLCJwdXNoIiwid3JpdGUiLCJzcGVjaWFsUXVlcnlrZXlzIiwiaXNTcGVjaWFsUXVlcnlLZXkiLCJrZXkiLCJpbmRleE9mIiwidmFsaWRhdGVRdWVyeSIsIlBhcnNlIiwiRXJyb3IiLCJJTlZBTElEX1FVRVJZIiwiJG9yIiwiQXJyYXkiLCJmb3JFYWNoIiwiJGFuZCIsIiRub3IiLCJsZW5ndGgiLCJPYmplY3QiLCJrZXlzIiwiJHJlZ2V4IiwiJG9wdGlvbnMiLCJtYXRjaCIsIklOVkFMSURfS0VZX05BTUUiLCJmaWx0ZXJTZW5zaXRpdmVEYXRhIiwiaXNNYXN0ZXIiLCJhY2xHcm91cCIsImF1dGgiLCJvcGVyYXRpb24iLCJzY2hlbWEiLCJjbGFzc05hbWUiLCJwcm90ZWN0ZWRGaWVsZHMiLCJvYmplY3QiLCJ1c2VySWQiLCJ1c2VyIiwiaWQiLCJwZXJtcyIsImdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImlzUmVhZE9wZXJhdGlvbiIsInByb3RlY3RlZEZpZWxkc1BvaW50ZXJQZXJtIiwiZmlsdGVyIiwic3RhcnRzV2l0aCIsIm1hcCIsInN1YnN0cmluZyIsInZhbHVlIiwibmV3UHJvdGVjdGVkRmllbGRzIiwib3ZlcnJpZGVQcm90ZWN0ZWRGaWVsZHMiLCJwb2ludGVyUGVybSIsInBvaW50ZXJQZXJtSW5jbHVkZXNVc2VyIiwicmVhZFVzZXJGaWVsZFZhbHVlIiwiaXNBcnJheSIsInNvbWUiLCJvYmplY3RJZCIsImZpZWxkcyIsInYiLCJpbmNsdWRlcyIsImlzVXNlckNsYXNzIiwiayIsInRlbXBvcmFyeUtleXMiLCJwYXNzd29yZCIsIl9oYXNoZWRfcGFzc3dvcmQiLCJzZXNzaW9uVG9rZW4iLCJfZW1haWxfdmVyaWZ5X3Rva2VuIiwiX3BlcmlzaGFibGVfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0IiwiX3RvbWJzdG9uZSIsIl9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCIsIl9mYWlsZWRfbG9naW5fY291bnQiLCJfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsIl9wYXNzd29yZF9oaXN0b3J5IiwiYXV0aERhdGEiLCJzcGVjaWFsS2V5c0ZvclVwZGF0ZSIsImlzU3BlY2lhbFVwZGF0ZUtleSIsImV4cGFuZFJlc3VsdE9uS2V5UGF0aCIsInBhdGgiLCJzcGxpdCIsImZpcnN0S2V5IiwibmV4dFBhdGgiLCJzbGljZSIsImpvaW4iLCJzYW5pdGl6ZURhdGFiYXNlUmVzdWx0Iiwib3JpZ2luYWxPYmplY3QiLCJyZXNwb25zZSIsIlByb21pc2UiLCJyZXNvbHZlIiwia2V5VXBkYXRlIiwiX19vcCIsImpvaW5UYWJsZU5hbWUiLCJmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlIiwiYW1vdW50IiwiSU5WQUxJRF9KU09OIiwib2JqZWN0cyIsIkNPTU1BTkRfVU5BVkFJTEFCTEUiLCJ0cmFuc2Zvcm1BdXRoRGF0YSIsInByb3ZpZGVyIiwicHJvdmlkZXJEYXRhIiwiZmllbGROYW1lIiwidHlwZSIsInVudHJhbnNmb3JtT2JqZWN0QUNMIiwib3V0cHV0IiwiZ2V0Um9vdEZpZWxkTmFtZSIsInJlbGF0aW9uU2NoZW1hIiwicmVsYXRlZElkIiwib3duaW5nSWQiLCJEYXRhYmFzZUNvbnRyb2xsZXIiLCJjb25zdHJ1Y3RvciIsImFkYXB0ZXIiLCJzY2hlbWFDYWNoZSIsInNjaGVtYVByb21pc2UiLCJfdHJhbnNhY3Rpb25hbFNlc3Npb24iLCJjb2xsZWN0aW9uRXhpc3RzIiwiY2xhc3NFeGlzdHMiLCJwdXJnZUNvbGxlY3Rpb24iLCJsb2FkU2NoZW1hIiwidGhlbiIsInNjaGVtYUNvbnRyb2xsZXIiLCJnZXRPbmVTY2hlbWEiLCJkZWxldGVPYmplY3RzQnlRdWVyeSIsInZhbGlkYXRlQ2xhc3NOYW1lIiwiU2NoZW1hQ29udHJvbGxlciIsImNsYXNzTmFtZUlzVmFsaWQiLCJyZWplY3QiLCJJTlZBTElEX0NMQVNTX05BTUUiLCJvcHRpb25zIiwiY2xlYXJDYWNoZSIsImxvYWQiLCJsb2FkU2NoZW1hSWZOZWVkZWQiLCJyZWRpcmVjdENsYXNzTmFtZUZvcktleSIsInQiLCJnZXRFeHBlY3RlZFR5cGUiLCJ0YXJnZXRDbGFzcyIsInZhbGlkYXRlT2JqZWN0IiwicnVuT3B0aW9ucyIsInVuZGVmaW5lZCIsInMiLCJjYW5BZGRGaWVsZCIsInVwZGF0ZSIsIm1hbnkiLCJ1cHNlcnQiLCJhZGRzRmllbGQiLCJza2lwU2FuaXRpemF0aW9uIiwidmFsaWRhdGVPbmx5IiwidmFsaWRTY2hlbWFDb250cm9sbGVyIiwib3JpZ2luYWxRdWVyeSIsIm9yaWdpbmFsVXBkYXRlIiwicmVsYXRpb25VcGRhdGVzIiwidmFsaWRhdGVQZXJtaXNzaW9uIiwiY29sbGVjdFJlbGF0aW9uVXBkYXRlcyIsImFkZFBvaW50ZXJQZXJtaXNzaW9ucyIsImNhdGNoIiwiZXJyb3IiLCJyb290RmllbGROYW1lIiwiZmllbGROYW1lSXNWYWxpZCIsInVwZGF0ZU9wZXJhdGlvbiIsImlubmVyS2V5IiwiSU5WQUxJRF9ORVNURURfS0VZIiwiZmluZCIsIk9CSkVDVF9OT1RfRk9VTkQiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwc2VydE9uZU9iamVjdCIsImZpbmRPbmVBbmRVcGRhdGUiLCJoYW5kbGVSZWxhdGlvblVwZGF0ZXMiLCJvcHMiLCJkZWxldGVNZSIsInByb2Nlc3MiLCJvcCIsIngiLCJwZW5kaW5nIiwiYWRkUmVsYXRpb24iLCJyZW1vdmVSZWxhdGlvbiIsImFsbCIsImZyb21DbGFzc05hbWUiLCJmcm9tSWQiLCJ0b0lkIiwiZG9jIiwiY29kZSIsImRlc3Ryb3kiLCJwYXJzZUZvcm1hdFNjaGVtYSIsImNyZWF0ZSIsImNyZWF0ZWRBdCIsImlzbyIsIl9fdHlwZSIsInVwZGF0ZWRBdCIsImVuZm9yY2VDbGFzc0V4aXN0cyIsImNyZWF0ZU9iamVjdCIsImNvbnZlcnRTY2hlbWFUb0FkYXB0ZXJTY2hlbWEiLCJjbGFzc1NjaGVtYSIsInNjaGVtYURhdGEiLCJzY2hlbWFGaWVsZHMiLCJuZXdLZXlzIiwiZmllbGQiLCJhY3Rpb24iLCJkZWxldGVFdmVyeXRoaW5nIiwiZmFzdCIsImRlbGV0ZUFsbENsYXNzZXMiLCJjbGVhciIsInJlbGF0ZWRJZHMiLCJxdWVyeU9wdGlvbnMiLCJza2lwIiwibGltaXQiLCJzb3J0IiwiZmluZE9wdGlvbnMiLCJjYW5Tb3J0T25Kb2luVGFibGVzIiwiX2lkIiwicmVzdWx0cyIsIm93bmluZ0lkcyIsInJlZHVjZUluUmVsYXRpb24iLCJvcnMiLCJhUXVlcnkiLCJpbmRleCIsInByb21pc2VzIiwicXVlcmllcyIsImNvbnN0cmFpbnRLZXkiLCJpc05lZ2F0aW9uIiwiciIsInEiLCJpZHMiLCJhZGROb3RJbk9iamVjdElkc0lkcyIsImFkZEluT2JqZWN0SWRzSWRzIiwicmVkdWNlUmVsYXRpb25LZXlzIiwicmVsYXRlZFRvIiwiaWRzRnJvbVN0cmluZyIsImlkc0Zyb21FcSIsImlkc0Zyb21JbiIsImFsbElkcyIsImxpc3QiLCJ0b3RhbExlbmd0aCIsInJlZHVjZSIsIm1lbW8iLCJpZHNJbnRlcnNlY3Rpb24iLCJpbnRlcnNlY3QiLCJiaWciLCIkZXEiLCJpZHNGcm9tTmluIiwiU2V0IiwiJG5pbiIsImNvdW50IiwiZGlzdGluY3QiLCJwaXBlbGluZSIsInJlYWRQcmVmZXJlbmNlIiwiaGludCIsImNhc2VJbnNlbnNpdGl2ZSIsImV4cGxhaW4iLCJ0cmFjZVByb21pc2UiLCJfY3JlYXRlZF9hdCIsIl91cGRhdGVkX2F0IiwiYWRkUHJvdGVjdGVkRmllbGRzIiwiYWdncmVnYXRlIiwiSU5URVJOQUxfU0VSVkVSX0VSUk9SIiwiZGVsZXRlU2NoZW1hIiwiZGVsZXRlQ2xhc3MiLCJ3YXNQYXJzZUNvbGxlY3Rpb24iLCJyZWxhdGlvbkZpZWxkTmFtZXMiLCJuYW1lIiwidGVzdFBlcm1pc3Npb25zRm9yQ2xhc3NOYW1lIiwidXNlckFDTCIsImdyb3VwS2V5IiwicGVybUZpZWxkcyIsInBvaW50ZXJGaWVsZHMiLCJ1c2VyUG9pbnRlciIsImZsYXRNYXAiLCJxYSIsIiRhbGwiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJhc3NpZ24iLCJwcmVzZXJ2ZUtleXMiLCJzZXJ2ZXJPbmx5S2V5cyIsImF1dGhlbnRpY2F0ZWQiLCJyb2xlcyIsInVzZXJSb2xlcyIsImFjYyIsInByb3RlY3RlZEtleXNTZXRzIiwicHJvdGVjdGVkS2V5cyIsIm5leHQiLCJjcmVhdGVUcmFuc2FjdGlvbmFsU2Vzc2lvbiIsInRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwicGVyZm9ybUluaXRpYWxpemF0aW9uIiwicmVxdWlyZWRVc2VyRmllbGRzIiwiZGVmYXVsdENvbHVtbnMiLCJfRGVmYXVsdCIsIl9Vc2VyIiwicmVxdWlyZWRSb2xlRmllbGRzIiwiX1JvbGUiLCJ1c2VyQ2xhc3NQcm9taXNlIiwicm9sZUNsYXNzUHJvbWlzZSIsInVzZXJuYW1lVW5pcXVlbmVzcyIsImVuc3VyZVVuaXF1ZW5lc3MiLCJsb2dnZXIiLCJ3YXJuIiwidXNlcm5hbWVDYXNlSW5zZW5zaXRpdmVJbmRleCIsImVuc3VyZUluZGV4IiwiZW1haWxVbmlxdWVuZXNzIiwiZW1haWxDYXNlSW5zZW5zaXRpdmVJbmRleCIsInJvbGVVbmlxdWVuZXNzIiwiaW5kZXhQcm9taXNlIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJhZGFwdGVySW5pdCIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJwcm9taXNlIiwibW9kdWxlIiwiZXhwb3J0cyIsIl92YWxpZGF0ZVF1ZXJ5Il0sIm1h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OztBQUNBdU0sTUFBTSxDQUFDQyxPQUFQLENBQWVDLGNBQWYsR0FBZ0MxUyxhQUFoQyIsInNvdXJjZXNDb250ZW50IjpbIu+7vy8vIEBmbG93XG4vLyBBIGRhdGFiYXNlIGFkYXB0ZXIgdGhhdCB3b3JrcyB3aXRoIGRhdGEgZXhwb3J0ZWQgZnJvbSB0aGUgaG9zdGVkXG4vLyBQYXJzZSBkYXRhYmFzZS5cblxuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgeyBQYXJzZSB9IGZyb20gJ3BhcnNlL25vZGUnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgXyBmcm9tICdsb2Rhc2gnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgaW50ZXJzZWN0IGZyb20gJ2ludGVyc2VjdCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBkZWVwY29weSBmcm9tICdkZWVwY29weSc7XG5pbXBvcnQgbG9nZ2VyIGZyb20gJy4uL2xvZ2dlcic7XG5pbXBvcnQgKiBhcyBTY2hlbWFDb250cm9sbGVyIGZyb20gJy4vU2NoZW1hQ29udHJvbGxlcic7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuaW1wb3J0IHR5cGUge1xuICBRdWVyeU9wdGlvbnMsXG4gIEZ1bGxRdWVyeU9wdGlvbnMsXG59IGZyb20gJy4uL0FkYXB0ZXJzL1N0b3JhZ2UvU3RvcmFnZUFkYXB0ZXInO1xuXG5pbXBvcnQgQVdTWFJheSBmcm9tICdodWxhYi14cmF5LXNkayc7XG5cbmZ1bmN0aW9uIGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpIHtcbiAgY29uc3QgbmV3UXVlcnkgPSBfLmNsb25lRGVlcChxdWVyeSk7XG4gIC8vQ2FuJ3QgYmUgYW55IGV4aXN0aW5nICdfd3Blcm0nIHF1ZXJ5LCB3ZSBkb24ndCBhbGxvdyBjbGllbnQgcXVlcmllcyBvbiB0aGF0LCBubyBuZWVkIHRvICRhbmRcbiAgbmV3UXVlcnkuX3dwZXJtID0geyAkaW46IFtudWxsLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuZnVuY3Rpb24gYWRkUmVhZEFDTChxdWVyeSwgYWNsKSB7XG4gIGNvbnN0IG5ld1F1ZXJ5ID0gXy5jbG9uZURlZXAocXVlcnkpO1xuICAvL0Nhbid0IGJlIGFueSBleGlzdGluZyAnX3JwZXJtJyBxdWVyeSwgd2UgZG9uJ3QgYWxsb3cgY2xpZW50IHF1ZXJpZXMgb24gdGhhdCwgbm8gbmVlZCB0byAkYW5kXG4gIG5ld1F1ZXJ5Ll9ycGVybSA9IHsgJGluOiBbbnVsbCwgJyonLCAuLi5hY2xdIH07XG4gIHJldHVybiBuZXdRdWVyeTtcbn1cblxuLy8gVHJhbnNmb3JtcyBhIFJFU1QgQVBJIGZvcm1hdHRlZCBBQ0wgb2JqZWN0IHRvIG91ciB0d28tZmllbGQgbW9uZ28gZm9ybWF0LlxuY29uc3QgdHJhbnNmb3JtT2JqZWN0QUNMID0gKHsgQUNMLCAuLi5yZXN1bHQgfSkgPT4ge1xuICBpZiAoIUFDTCkge1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICByZXN1bHQuX3dwZXJtID0gW107XG4gIHJlc3VsdC5fcnBlcm0gPSBbXTtcblxuICBmb3IgKGNvbnN0IGVudHJ5IGluIEFDTCkge1xuICAgIGlmIChBQ0xbZW50cnldLnJlYWQpIHtcbiAgICAgIHJlc3VsdC5fcnBlcm0ucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIGlmIChBQ0xbZW50cnldLndyaXRlKSB7XG4gICAgICByZXN1bHQuX3dwZXJtLnB1c2goZW50cnkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcmVzdWx0O1xufTtcblxuY29uc3Qgc3BlY2lhbFF1ZXJ5a2V5cyA9IFtcbiAgJyRhbmQnLFxuICAnJG9yJyxcbiAgJyRub3InLFxuICAnX3JwZXJtJyxcbiAgJ193cGVybScsXG4gICdfcGVyaXNoYWJsZV90b2tlbicsXG4gICdfZW1haWxfdmVyaWZ5X3Rva2VuJyxcbiAgJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcsXG4gICdfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQnLFxuICAnX2ZhaWxlZF9sb2dpbl9jb3VudCcsXG5dO1xuXG5jb25zdCBpc1NwZWNpYWxRdWVyeUtleSA9IGtleSA9PiB7XG4gIHJldHVybiBzcGVjaWFsUXVlcnlrZXlzLmluZGV4T2Yoa2V5KSA+PSAwO1xufTtcblxuY29uc3QgdmFsaWRhdGVRdWVyeSA9IChxdWVyeTogYW55KTogdm9pZCA9PiB7XG4gIGlmIChxdWVyeS5BQ0wpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgJ0Nhbm5vdCBxdWVyeSBvbiBBQ0wuJyk7XG4gIH1cblxuICBpZiAocXVlcnkuJG9yKSB7XG4gICAgaWYgKHF1ZXJ5LiRvciBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICBxdWVyeS4kb3IuZm9yRWFjaCh2YWxpZGF0ZVF1ZXJ5KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAnQmFkICRvciBmb3JtYXQgLSB1c2UgYW4gYXJyYXkgdmFsdWUuJ1xuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBpZiAocXVlcnkuJGFuZCkge1xuICAgIGlmIChxdWVyeS4kYW5kIGluc3RhbmNlb2YgQXJyYXkpIHtcbiAgICAgIHF1ZXJ5LiRhbmQuZm9yRWFjaCh2YWxpZGF0ZVF1ZXJ5KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLFxuICAgICAgICAnQmFkICRhbmQgZm9ybWF0IC0gdXNlIGFuIGFycmF5IHZhbHVlLidcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHF1ZXJ5LiRub3IpIHtcbiAgICBpZiAocXVlcnkuJG5vciBpbnN0YW5jZW9mIEFycmF5ICYmIHF1ZXJ5LiRub3IubGVuZ3RoID4gMCkge1xuICAgICAgcXVlcnkuJG5vci5mb3JFYWNoKHZhbGlkYXRlUXVlcnkpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICdCYWQgJG5vciBmb3JtYXQgLSB1c2UgYW4gYXJyYXkgb2YgYXQgbGVhc3QgMSB2YWx1ZS4nXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIE9iamVjdC5rZXlzKHF1ZXJ5KS5mb3JFYWNoKGtleSA9PiB7XG4gICAgaWYgKHF1ZXJ5ICYmIHF1ZXJ5W2tleV0gJiYgcXVlcnlba2V5XS4kcmVnZXgpIHtcbiAgICAgIGlmICh0eXBlb2YgcXVlcnlba2V5XS4kb3B0aW9ucyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgaWYgKCFxdWVyeVtrZXldLiRvcHRpb25zLm1hdGNoKC9eW2lteHNdKyQvKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgICBgQmFkICRvcHRpb25zIHZhbHVlIGZvciBxdWVyeTogJHtxdWVyeVtrZXldLiRvcHRpb25zfWBcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGlmICghaXNTcGVjaWFsUXVlcnlLZXkoa2V5KSAmJiAha2V5Lm1hdGNoKC9eW2EtekEtWl1bYS16QS1aMC05X1xcLl0qJC8pKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgIGBJbnZhbGlkIGtleSBuYW1lOiAke2tleX1gXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG59O1xuXG4vLyBGaWx0ZXJzIG91dCBhbnkgZGF0YSB0aGF0IHNob3VsZG4ndCBiZSBvbiB0aGlzIFJFU1QtZm9ybWF0dGVkIG9iamVjdC5cbmNvbnN0IGZpbHRlclNlbnNpdGl2ZURhdGEgPSAoXG4gIGlzTWFzdGVyOiBib29sZWFuLFxuICBhY2xHcm91cDogYW55W10sXG4gIGF1dGg6IGFueSxcbiAgb3BlcmF0aW9uOiBhbnksXG4gIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICBjbGFzc05hbWU6IHN0cmluZyxcbiAgcHJvdGVjdGVkRmllbGRzOiBudWxsIHwgQXJyYXk8YW55PixcbiAgb2JqZWN0OiBhbnlcbikgPT4ge1xuICBsZXQgdXNlcklkID0gbnVsbDtcbiAgaWYgKGF1dGggJiYgYXV0aC51c2VyKSB1c2VySWQgPSBhdXRoLnVzZXIuaWQ7XG5cbiAgLy8gcmVwbGFjZSBwcm90ZWN0ZWRGaWVsZHMgd2hlbiB1c2luZyBwb2ludGVyLXBlcm1pc3Npb25zXG4gIGNvbnN0IHBlcm1zID0gc2NoZW1hLmdldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWUpO1xuICBpZiAocGVybXMpIHtcbiAgICBjb25zdCBpc1JlYWRPcGVyYXRpb24gPSBbJ2dldCcsICdmaW5kJ10uaW5kZXhPZihvcGVyYXRpb24pID4gLTE7XG5cbiAgICBpZiAoaXNSZWFkT3BlcmF0aW9uICYmIHBlcm1zLnByb3RlY3RlZEZpZWxkcykge1xuICAgICAgLy8gZXh0cmFjdCBwcm90ZWN0ZWRGaWVsZHMgYWRkZWQgd2l0aCB0aGUgcG9pbnRlci1wZXJtaXNzaW9uIHByZWZpeFxuICAgICAgY29uc3QgcHJvdGVjdGVkRmllbGRzUG9pbnRlclBlcm0gPSBPYmplY3Qua2V5cyhwZXJtcy5wcm90ZWN0ZWRGaWVsZHMpXG4gICAgICAgIC5maWx0ZXIoa2V5ID0+IGtleS5zdGFydHNXaXRoKCd1c2VyRmllbGQ6JykpXG4gICAgICAgIC5tYXAoa2V5ID0+IHtcbiAgICAgICAgICByZXR1cm4geyBrZXk6IGtleS5zdWJzdHJpbmcoMTApLCB2YWx1ZTogcGVybXMucHJvdGVjdGVkRmllbGRzW2tleV0gfTtcbiAgICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG5ld1Byb3RlY3RlZEZpZWxkczogQXJyYXk8c3RyaW5nPltdID0gW107XG4gICAgICBsZXQgb3ZlcnJpZGVQcm90ZWN0ZWRGaWVsZHMgPSBmYWxzZTtcblxuICAgICAgLy8gY2hlY2sgaWYgdGhlIG9iamVjdCBncmFudHMgdGhlIGN1cnJlbnQgdXNlciBhY2Nlc3MgYmFzZWQgb24gdGhlIGV4dHJhY3RlZCBmaWVsZHNcbiAgICAgIHByb3RlY3RlZEZpZWxkc1BvaW50ZXJQZXJtLmZvckVhY2gocG9pbnRlclBlcm0gPT4ge1xuICAgICAgICBsZXQgcG9pbnRlclBlcm1JbmNsdWRlc1VzZXIgPSBmYWxzZTtcbiAgICAgICAgY29uc3QgcmVhZFVzZXJGaWVsZFZhbHVlID0gb2JqZWN0W3BvaW50ZXJQZXJtLmtleV07XG4gICAgICAgIGlmIChyZWFkVXNlckZpZWxkVmFsdWUpIHtcbiAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZWFkVXNlckZpZWxkVmFsdWUpKSB7XG4gICAgICAgICAgICBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9IHJlYWRVc2VyRmllbGRWYWx1ZS5zb21lKFxuICAgICAgICAgICAgICB1c2VyID0+IHVzZXIub2JqZWN0SWQgJiYgdXNlci5vYmplY3RJZCA9PT0gdXNlcklkXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwb2ludGVyUGVybUluY2x1ZGVzVXNlciA9XG4gICAgICAgICAgICAgIHJlYWRVc2VyRmllbGRWYWx1ZS5vYmplY3RJZCAmJlxuICAgICAgICAgICAgICByZWFkVXNlckZpZWxkVmFsdWUub2JqZWN0SWQgPT09IHVzZXJJZDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAocG9pbnRlclBlcm1JbmNsdWRlc1VzZXIpIHtcbiAgICAgICAgICBvdmVycmlkZVByb3RlY3RlZEZpZWxkcyA9IHRydWU7XG4gICAgICAgICAgbmV3UHJvdGVjdGVkRmllbGRzLnB1c2gocG9pbnRlclBlcm0udmFsdWUpO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgLy8gaWYgYXQgbGVhc3Qgb25lIHBvaW50ZXItcGVybWlzc2lvbiBhZmZlY3RlZCB0aGUgY3VycmVudCB1c2VyXG4gICAgICAvLyBpbnRlcnNlY3QgdnMgcHJvdGVjdGVkRmllbGRzIGZyb20gcHJldmlvdXMgc3RhZ2UgKEBzZWUgYWRkUHJvdGVjdGVkRmllbGRzKVxuICAgICAgLy8gU2V0cyB0aGVvcnkgKGludGVyc2VjdGlvbnMpOiBBIHggKEIgeCBDKSA9PSAoQSB4IEIpIHggQ1xuICAgICAgaWYgKG92ZXJyaWRlUHJvdGVjdGVkRmllbGRzICYmIHByb3RlY3RlZEZpZWxkcykge1xuICAgICAgICBuZXdQcm90ZWN0ZWRGaWVsZHMucHVzaChwcm90ZWN0ZWRGaWVsZHMpO1xuICAgICAgfVxuICAgICAgLy8gaW50ZXJzZWN0IGFsbCBzZXRzIG9mIHByb3RlY3RlZEZpZWxkc1xuICAgICAgbmV3UHJvdGVjdGVkRmllbGRzLmZvckVhY2goZmllbGRzID0+IHtcbiAgICAgICAgaWYgKGZpZWxkcykge1xuICAgICAgICAgIC8vIGlmIHRoZXJlJ3JlIG5vIHByb3RjdGVkRmllbGRzIGJ5IG90aGVyIGNyaXRlcmlhICggaWQgLyByb2xlIC8gYXV0aClcbiAgICAgICAgICAvLyB0aGVuIHdlIG11c3QgaW50ZXJzZWN0IGVhY2ggc2V0IChwZXIgdXNlckZpZWxkKVxuICAgICAgICAgIGlmICghcHJvdGVjdGVkRmllbGRzKSB7XG4gICAgICAgICAgICBwcm90ZWN0ZWRGaWVsZHMgPSBmaWVsZHM7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IHByb3RlY3RlZEZpZWxkcy5maWx0ZXIodiA9PiBmaWVsZHMuaW5jbHVkZXModikpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgaXNVc2VyQ2xhc3MgPSBjbGFzc05hbWUgPT09ICdfVXNlcic7XG5cbiAgLyogc3BlY2lhbCB0cmVhdCBmb3IgdGhlIHVzZXIgY2xhc3M6IGRvbid0IGZpbHRlciBwcm90ZWN0ZWRGaWVsZHMgaWYgY3VycmVudGx5IGxvZ2dlZGluIHVzZXIgaXNcbiAgdGhlIHJldHJpZXZlZCB1c2VyICovXG4gIGlmICghKGlzVXNlckNsYXNzICYmIHVzZXJJZCAmJiBvYmplY3Qub2JqZWN0SWQgPT09IHVzZXJJZCkpIHtcbiAgICBwcm90ZWN0ZWRGaWVsZHMgJiYgcHJvdGVjdGVkRmllbGRzLmZvckVhY2goayA9PiBkZWxldGUgb2JqZWN0W2tdKTtcblxuICAgIC8vIGZpZWxkcyBub3QgcmVxdWVzdGVkIGJ5IGNsaWVudCAoZXhjbHVkZWQpLFxuICAgIC8vYnV0IHdlcmUgbmVlZGVkIHRvIGFwcGx5IHByb3RlY3R0ZWRGaWVsZHNcbiAgICBwZXJtcy5wcm90ZWN0ZWRGaWVsZHMgJiZcbiAgICAgIHBlcm1zLnByb3RlY3RlZEZpZWxkcy50ZW1wb3JhcnlLZXlzICYmXG4gICAgICBwZXJtcy5wcm90ZWN0ZWRGaWVsZHMudGVtcG9yYXJ5S2V5cy5mb3JFYWNoKGsgPT4gZGVsZXRlIG9iamVjdFtrXSk7XG4gIH1cblxuICBpZiAoIWlzVXNlckNsYXNzKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuXG4gIG9iamVjdC5wYXNzd29yZCA9IG9iamVjdC5faGFzaGVkX3Bhc3N3b3JkO1xuICBkZWxldGUgb2JqZWN0Ll9oYXNoZWRfcGFzc3dvcmQ7XG5cbiAgZGVsZXRlIG9iamVjdC5zZXNzaW9uVG9rZW47XG5cbiAgaWYgKGlzTWFzdGVyKSB7XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICBkZWxldGUgb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW47XG4gIGRlbGV0ZSBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW47XG4gIGRlbGV0ZSBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fdG9tYnN0b25lO1xuICBkZWxldGUgb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fZmFpbGVkX2xvZ2luX2NvdW50O1xuICBkZWxldGUgb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdDtcbiAgZGVsZXRlIG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdDtcbiAgZGVsZXRlIG9iamVjdC5fcGFzc3dvcmRfaGlzdG9yeTtcblxuICBpZiAoYWNsR3JvdXAuaW5kZXhPZihvYmplY3Qub2JqZWN0SWQpID4gLTEpIHtcbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG4gIGRlbGV0ZSBvYmplY3QuYXV0aERhdGE7XG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5pbXBvcnQgdHlwZSB7IExvYWRTY2hlbWFPcHRpb25zIH0gZnJvbSAnLi90eXBlcyc7XG5cbi8vIFJ1bnMgYW4gdXBkYXRlIG9uIHRoZSBkYXRhYmFzZS5cbi8vIFJldHVybnMgYSBwcm9taXNlIGZvciBhbiBvYmplY3Qgd2l0aCB0aGUgbmV3IHZhbHVlcyBmb3IgZmllbGRcbi8vIG1vZGlmaWNhdGlvbnMgdGhhdCBkb24ndCBrbm93IHRoZWlyIHJlc3VsdHMgYWhlYWQgb2YgdGltZSwgbGlrZVxuLy8gJ2luY3JlbWVudCcuXG4vLyBPcHRpb25zOlxuLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4vLyAgICAgICAgIG9uZSBvZiB0aGUgcHJvdmlkZWQgc3RyaW5ncyBtdXN0IHByb3ZpZGUgdGhlIGNhbGxlciB3aXRoXG4vLyAgICAgICAgIHdyaXRlIHBlcm1pc3Npb25zLlxuY29uc3Qgc3BlY2lhbEtleXNGb3JVcGRhdGUgPSBbXG4gICdfaGFzaGVkX3Bhc3N3b3JkJyxcbiAgJ19wZXJpc2hhYmxlX3Rva2VuJyxcbiAgJ19lbWFpbF92ZXJpZnlfdG9rZW4nLFxuICAnX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0JyxcbiAgJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCcsXG4gICdfZmFpbGVkX2xvZ2luX2NvdW50JyxcbiAgJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnLFxuICAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnLFxuICAnX3Bhc3N3b3JkX2hpc3RvcnknLFxuXTtcblxuY29uc3QgaXNTcGVjaWFsVXBkYXRlS2V5ID0ga2V5ID0+IHtcbiAgcmV0dXJuIHNwZWNpYWxLZXlzRm9yVXBkYXRlLmluZGV4T2Yoa2V5KSA+PSAwO1xufTtcblxuZnVuY3Rpb24gZXhwYW5kUmVzdWx0T25LZXlQYXRoKG9iamVjdCwga2V5LCB2YWx1ZSkge1xuICBpZiAoa2V5LmluZGV4T2YoJy4nKSA8IDApIHtcbiAgICBvYmplY3Rba2V5XSA9IHZhbHVlW2tleV07XG4gICAgcmV0dXJuIG9iamVjdDtcbiAgfVxuICBjb25zdCBwYXRoID0ga2V5LnNwbGl0KCcuJyk7XG4gIGNvbnN0IGZpcnN0S2V5ID0gcGF0aFswXTtcbiAgY29uc3QgbmV4dFBhdGggPSBwYXRoLnNsaWNlKDEpLmpvaW4oJy4nKTtcbiAgb2JqZWN0W2ZpcnN0S2V5XSA9IGV4cGFuZFJlc3VsdE9uS2V5UGF0aChcbiAgICBvYmplY3RbZmlyc3RLZXldIHx8IHt9LFxuICAgIG5leHRQYXRoLFxuICAgIHZhbHVlW2ZpcnN0S2V5XVxuICApO1xuICBkZWxldGUgb2JqZWN0W2tleV07XG4gIHJldHVybiBvYmplY3Q7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdCk6IFByb21pc2U8YW55PiB7XG4gIGNvbnN0IHJlc3BvbnNlID0ge307XG4gIGlmICghcmVzdWx0KSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShyZXNwb25zZSk7XG4gIH1cbiAgT2JqZWN0LmtleXMob3JpZ2luYWxPYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICBjb25zdCBrZXlVcGRhdGUgPSBvcmlnaW5hbE9iamVjdFtrZXldO1xuICAgIC8vIGRldGVybWluZSBpZiB0aGF0IHdhcyBhbiBvcFxuICAgIGlmIChcbiAgICAgIGtleVVwZGF0ZSAmJlxuICAgICAgdHlwZW9mIGtleVVwZGF0ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgIGtleVVwZGF0ZS5fX29wICYmXG4gICAgICBbJ0FkZCcsICdBZGRVbmlxdWUnLCAnUmVtb3ZlJywgJ0luY3JlbWVudCddLmluZGV4T2Yoa2V5VXBkYXRlLl9fb3ApID4gLTFcbiAgICApIHtcbiAgICAgIC8vIG9ubHkgdmFsaWQgb3BzIHRoYXQgcHJvZHVjZSBhbiBhY3Rpb25hYmxlIHJlc3VsdFxuICAgICAgLy8gdGhlIG9wIG1heSBoYXZlIGhhcHBlbmQgb24gYSBrZXlwYXRoXG4gICAgICBleHBhbmRSZXN1bHRPbktleVBhdGgocmVzcG9uc2UsIGtleSwgcmVzdWx0KTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHJlc3BvbnNlKTtcbn1cblxuZnVuY3Rpb24gam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSkge1xuICByZXR1cm4gYF9Kb2luOiR7a2V5fToke2NsYXNzTmFtZX1gO1xufVxuXG5jb25zdCBmbGF0dGVuVXBkYXRlT3BlcmF0b3JzRm9yQ3JlYXRlID0gb2JqZWN0ID0+IHtcbiAgZm9yIChjb25zdCBrZXkgaW4gb2JqZWN0KSB7XG4gICAgaWYgKG9iamVjdFtrZXldICYmIG9iamVjdFtrZXldLl9fb3ApIHtcbiAgICAgIHN3aXRjaCAob2JqZWN0W2tleV0uX19vcCkge1xuICAgICAgICBjYXNlICdJbmNyZW1lbnQnOlxuICAgICAgICAgIGlmICh0eXBlb2Ygb2JqZWN0W2tleV0uYW1vdW50ICE9PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5J1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5hbW91bnQ7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FkZCc6XG4gICAgICAgICAgaWYgKCEob2JqZWN0W2tleV0ub2JqZWN0cyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICdvYmplY3RzIHRvIGFkZCBtdXN0IGJlIGFuIGFycmF5J1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgb2JqZWN0W2tleV0gPSBvYmplY3Rba2V5XS5vYmplY3RzO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdBZGRVbmlxdWUnOlxuICAgICAgICAgIGlmICghKG9iamVjdFtrZXldLm9iamVjdHMgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgICAnb2JqZWN0cyB0byBhZGQgbXVzdCBiZSBhbiBhcnJheSdcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIG9iamVjdFtrZXldID0gb2JqZWN0W2tleV0ub2JqZWN0cztcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUmVtb3ZlJzpcbiAgICAgICAgICBpZiAoIShvYmplY3Rba2V5XS5vYmplY3RzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgJ29iamVjdHMgdG8gYWRkIG11c3QgYmUgYW4gYXJyYXknXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBvYmplY3Rba2V5XSA9IFtdO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdEZWxldGUnOlxuICAgICAgICAgIGRlbGV0ZSBvYmplY3Rba2V5XTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5DT01NQU5EX1VOQVZBSUxBQkxFLFxuICAgICAgICAgICAgYFRoZSAke29iamVjdFtrZXldLl9fb3B9IG9wZXJhdG9yIGlzIG5vdCBzdXBwb3J0ZWQgeWV0LmBcbiAgICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfVxufTtcblxuY29uc3QgdHJhbnNmb3JtQXV0aERhdGEgPSAoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkgPT4ge1xuICBpZiAob2JqZWN0LmF1dGhEYXRhICYmIGNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIE9iamVjdC5rZXlzKG9iamVjdC5hdXRoRGF0YSkuZm9yRWFjaChwcm92aWRlciA9PiB7XG4gICAgICBjb25zdCBwcm92aWRlckRhdGEgPSBvYmplY3QuYXV0aERhdGFbcHJvdmlkZXJdO1xuICAgICAgY29uc3QgZmllbGROYW1lID0gYF9hdXRoX2RhdGFfJHtwcm92aWRlcn1gO1xuICAgICAgaWYgKHByb3ZpZGVyRGF0YSA9PSBudWxsKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fb3A6ICdEZWxldGUnLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSBwcm92aWRlckRhdGE7XG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSA9IHsgdHlwZTogJ09iamVjdCcgfTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBkZWxldGUgb2JqZWN0LmF1dGhEYXRhO1xuICB9XG59O1xuLy8gVHJhbnNmb3JtcyBhIERhdGFiYXNlIGZvcm1hdCBBQ0wgdG8gYSBSRVNUIEFQSSBmb3JtYXQgQUNMXG5jb25zdCB1bnRyYW5zZm9ybU9iamVjdEFDTCA9ICh7IF9ycGVybSwgX3dwZXJtLCAuLi5vdXRwdXQgfSkgPT4ge1xuICBpZiAoX3JwZXJtIHx8IF93cGVybSkge1xuICAgIG91dHB1dC5BQ0wgPSB7fTtcblxuICAgIChfcnBlcm0gfHwgW10pLmZvckVhY2goZW50cnkgPT4ge1xuICAgICAgaWYgKCFvdXRwdXQuQUNMW2VudHJ5XSkge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XSA9IHsgcmVhZDogdHJ1ZSB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV1bJ3JlYWQnXSA9IHRydWU7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICAoX3dwZXJtIHx8IFtdKS5mb3JFYWNoKGVudHJ5ID0+IHtcbiAgICAgIGlmICghb3V0cHV0LkFDTFtlbnRyeV0pIHtcbiAgICAgICAgb3V0cHV0LkFDTFtlbnRyeV0gPSB7IHdyaXRlOiB0cnVlIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBvdXRwdXQuQUNMW2VudHJ5XVsnd3JpdGUnXSA9IHRydWU7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG91dHB1dDtcbn07XG5cbi8qKlxuICogV2hlbiBxdWVyeWluZywgdGhlIGZpZWxkTmFtZSBtYXkgYmUgY29tcG91bmQsIGV4dHJhY3QgdGhlIHJvb3QgZmllbGROYW1lXG4gKiAgICAgYHRlbXBlcmF0dXJlLmNlbHNpdXNgIGJlY29tZXMgYHRlbXBlcmF0dXJlYFxuICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSB0aGF0IG1heSBiZSBhIGNvbXBvdW5kIGZpZWxkIG5hbWVcbiAqIEByZXR1cm5zIHtzdHJpbmd9IHRoZSByb290IG5hbWUgb2YgdGhlIGZpZWxkXG4gKi9cbmNvbnN0IGdldFJvb3RGaWVsZE5hbWUgPSAoZmllbGROYW1lOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICByZXR1cm4gZmllbGROYW1lLnNwbGl0KCcuJylbMF07XG59O1xuXG5jb25zdCByZWxhdGlvblNjaGVtYSA9IHtcbiAgZmllbGRzOiB7IHJlbGF0ZWRJZDogeyB0eXBlOiAnU3RyaW5nJyB9LCBvd25pbmdJZDogeyB0eXBlOiAnU3RyaW5nJyB9IH0sXG59O1xuXG5jbGFzcyBEYXRhYmFzZUNvbnRyb2xsZXIge1xuICBhZGFwdGVyOiBTdG9yYWdlQWRhcHRlcjtcbiAgc2NoZW1hQ2FjaGU6IGFueTtcbiAgc2NoZW1hUHJvbWlzZTogP1Byb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPjtcbiAgX3RyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55O1xuXG4gIGNvbnN0cnVjdG9yKGFkYXB0ZXI6IFN0b3JhZ2VBZGFwdGVyLCBzY2hlbWFDYWNoZTogYW55KSB7XG4gICAgdGhpcy5hZGFwdGVyID0gYWRhcHRlcjtcbiAgICB0aGlzLnNjaGVtYUNhY2hlID0gc2NoZW1hQ2FjaGU7XG4gICAgLy8gV2UgZG9uJ3Qgd2FudCBhIG11dGFibGUgdGhpcy5zY2hlbWEsIGJlY2F1c2UgdGhlbiB5b3UgY291bGQgaGF2ZVxuICAgIC8vIG9uZSByZXF1ZXN0IHRoYXQgdXNlcyBkaWZmZXJlbnQgc2NoZW1hcyBmb3IgZGlmZmVyZW50IHBhcnRzIG9mXG4gICAgLy8gaXQuIEluc3RlYWQsIHVzZSBsb2FkU2NoZW1hIHRvIGdldCBhIHNjaGVtYS5cbiAgICB0aGlzLnNjaGVtYVByb21pc2UgPSBudWxsO1xuICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uID0gbnVsbDtcbiAgfVxuXG4gIGNvbGxlY3Rpb25FeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmNsYXNzRXhpc3RzKGNsYXNzTmFtZSk7XG4gIH1cblxuICBwdXJnZUNvbGxlY3Rpb24oY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4gc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lKSlcbiAgICAgIC50aGVuKHNjaGVtYSA9PiB0aGlzLmFkYXB0ZXIuZGVsZXRlT2JqZWN0c0J5UXVlcnkoY2xhc3NOYW1lLCBzY2hlbWEsIHt9KSk7XG4gIH1cblxuICB2YWxpZGF0ZUNsYXNzTmFtZShjbGFzc05hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghU2NoZW1hQ29udHJvbGxlci5jbGFzc05hbWVJc1ZhbGlkKGNsYXNzTmFtZSkpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChcbiAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRSxcbiAgICAgICAgICAnaW52YWxpZCBjbGFzc05hbWU6ICcgKyBjbGFzc05hbWVcbiAgICAgICAgKVxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgZm9yIGEgc2NoZW1hQ29udHJvbGxlci5cbiAgbG9hZFNjaGVtYShcbiAgICBvcHRpb25zOiBMb2FkU2NoZW1hT3B0aW9ucyA9IHsgY2xlYXJDYWNoZTogZmFsc2UgfVxuICApOiBQcm9taXNlPFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlcj4ge1xuICAgIGlmICh0aGlzLnNjaGVtYVByb21pc2UgIT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHRoaXMuc2NoZW1hUHJvbWlzZTtcbiAgICB9XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gU2NoZW1hQ29udHJvbGxlci5sb2FkKFxuICAgICAgdGhpcy5hZGFwdGVyLFxuICAgICAgdGhpcy5zY2hlbWFDYWNoZSxcbiAgICAgIG9wdGlvbnNcbiAgICApO1xuICAgIHRoaXMuc2NoZW1hUHJvbWlzZS50aGVuKFxuICAgICAgKCkgPT4gZGVsZXRlIHRoaXMuc2NoZW1hUHJvbWlzZSxcbiAgICAgICgpID0+IGRlbGV0ZSB0aGlzLnNjaGVtYVByb21pc2VcbiAgICApO1xuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWEob3B0aW9ucyk7XG4gIH1cblxuICBsb2FkU2NoZW1hSWZOZWVkZWQoXG4gICAgc2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIG9wdGlvbnM6IExvYWRTY2hlbWFPcHRpb25zID0geyBjbGVhckNhY2hlOiBmYWxzZSB9XG4gICk6IFByb21pc2U8U2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyPiB7XG4gICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgID8gUHJvbWlzZS5yZXNvbHZlKHNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICA6IHRoaXMubG9hZFNjaGVtYShvcHRpb25zKTtcbiAgfVxuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIGZvciB0aGUgY2xhc3NuYW1lIHRoYXQgaXMgcmVsYXRlZCB0byB0aGUgZ2l2ZW5cbiAgLy8gY2xhc3NuYW1lIHRocm91Z2ggdGhlIGtleS5cbiAgLy8gVE9ETzogbWFrZSB0aGlzIG5vdCBpbiB0aGUgRGF0YWJhc2VDb250cm9sbGVyIGludGVyZmFjZVxuICByZWRpcmVjdENsYXNzTmFtZUZvcktleShjbGFzc05hbWU6IHN0cmluZywga2V5OiBzdHJpbmcpOiBQcm9taXNlPD9zdHJpbmc+IHtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT4ge1xuICAgICAgdmFyIHQgPSBzY2hlbWEuZ2V0RXhwZWN0ZWRUeXBlKGNsYXNzTmFtZSwga2V5KTtcbiAgICAgIGlmICh0ICE9IG51bGwgJiYgdHlwZW9mIHQgIT09ICdzdHJpbmcnICYmIHQudHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gdC50YXJnZXRDbGFzcztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjbGFzc05hbWU7XG4gICAgfSk7XG4gIH1cblxuICAvLyBVc2VzIHRoZSBzY2hlbWEgdG8gdmFsaWRhdGUgdGhlIG9iamVjdCAoUkVTVCBBUEkgZm9ybWF0KS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byB0aGUgbmV3IHNjaGVtYS5cbiAgLy8gVGhpcyBkb2VzIG5vdCB1cGRhdGUgdGhpcy5zY2hlbWEsIGJlY2F1c2UgaW4gYSBzaXR1YXRpb24gbGlrZSBhXG4gIC8vIGJhdGNoIHJlcXVlc3QsIHRoYXQgY291bGQgY29uZnVzZSBvdGhlciB1c2VycyBvZiB0aGUgc2NoZW1hLlxuICB2YWxpZGF0ZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3Q6IGFueSxcbiAgICBxdWVyeTogYW55LFxuICAgIHJ1bk9wdGlvbnM6IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBsZXQgc2NoZW1hO1xuICAgIGNvbnN0IGFjbCA9IHJ1bk9wdGlvbnMuYWNsO1xuICAgIGNvbnN0IGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgdmFyIGFjbEdyb3VwOiBzdHJpbmdbXSA9IGFjbCB8fCBbXTtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKClcbiAgICAgIC50aGVuKHMgPT4ge1xuICAgICAgICBzY2hlbWEgPSBzO1xuICAgICAgICBpZiAoaXNNYXN0ZXIpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FuQWRkRmllbGQoXG4gICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgcnVuT3B0aW9uc1xuICAgICAgICApO1xuICAgICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHNjaGVtYS52YWxpZGF0ZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgcXVlcnkpO1xuICAgICAgfSk7XG4gIH1cblxuICB1cGRhdGUoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB7IGFjbCwgbWFueSwgdXBzZXJ0LCBhZGRzRmllbGQgfTogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHNraXBTYW5pdGl6YXRpb246IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZGF0ZU9ubHk6IGJvb2xlYW4gPSBmYWxzZSxcbiAgICB2YWxpZFNjaGVtYUNvbnRyb2xsZXI6IFNjaGVtYUNvbnRyb2xsZXIuU2NoZW1hQ29udHJvbGxlclxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IG9yaWdpbmFsUXVlcnkgPSBxdWVyeTtcbiAgICBjb25zdCBvcmlnaW5hbFVwZGF0ZSA9IHVwZGF0ZTtcbiAgICAvLyBNYWtlIGEgY29weSBvZiB0aGUgb2JqZWN0LCBzbyB3ZSBkb24ndCBtdXRhdGUgdGhlIGluY29taW5nIGRhdGEuXG4gICAgdXBkYXRlID0gZGVlcGNvcHkodXBkYXRlKTtcbiAgICB2YXIgcmVsYXRpb25VcGRhdGVzID0gW107XG4gICAgdmFyIGlzTWFzdGVyID0gYWNsID09PSB1bmRlZmluZWQ7XG4gICAgdmFyIGFjbEdyb3VwID0gYWNsIHx8IFtdO1xuXG4gICAgcmV0dXJuIHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikudGhlbihcbiAgICAgIHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgICByZXR1cm4gKGlzTWFzdGVyXG4gICAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoKVxuICAgICAgICAgIDogc2NoZW1hQ29udHJvbGxlci52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ3VwZGF0ZScpXG4gICAgICAgIClcbiAgICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgICByZWxhdGlvblVwZGF0ZXMgPSB0aGlzLmNvbGxlY3RSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb3JpZ2luYWxRdWVyeS5vYmplY3RJZCxcbiAgICAgICAgICAgICAgdXBkYXRlXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICBxdWVyeSA9IHRoaXMuYWRkUG9pbnRlclBlcm1pc3Npb25zKFxuICAgICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICd1cGRhdGUnLFxuICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgaWYgKGFkZHNGaWVsZCkge1xuICAgICAgICAgICAgICAgIHF1ZXJ5ID0ge1xuICAgICAgICAgICAgICAgICAgJGFuZDogW1xuICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgJ2FkZEZpZWxkJyxcbiAgICAgICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgICAgICBhY2xHcm91cFxuICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhY2wpIHtcbiAgICAgICAgICAgICAgcXVlcnkgPSBhZGRXcml0ZUFDTChxdWVyeSwgYWNsKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhbGlkYXRlUXVlcnkocXVlcnkpO1xuICAgICAgICAgICAgcmV0dXJuIHNjaGVtYUNvbnRyb2xsZXJcbiAgICAgICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpXG4gICAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgLy8gSWYgdGhlIHNjaGVtYSBkb2Vzbid0IGV4aXN0LCBwcmV0ZW5kIGl0IGV4aXN0cyB3aXRoIG5vIGZpZWxkcy4gVGhpcyBiZWhhdmlvclxuICAgICAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgICAgICBpZiAoZXJyb3IgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgICAgICAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUubWF0Y2goL15hdXRoRGF0YVxcLihbYS16QS1aMC05X10rKVxcLmlkJC8pKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLFxuICAgICAgICAgICAgICAgICAgICAgIGBJbnZhbGlkIGZpZWxkIG5hbWUgZm9yIHVwZGF0ZTogJHtmaWVsZE5hbWV9YFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgY29uc3Qgcm9vdEZpZWxkTmFtZSA9IGdldFJvb3RGaWVsZE5hbWUoZmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgICAgICAgIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lKSAmJlxuICAgICAgICAgICAgICAgICAgICAhaXNTcGVjaWFsVXBkYXRlS2V5KHJvb3RGaWVsZE5hbWUpXG4gICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgICAgICAgYEludmFsaWQgZmllbGQgbmFtZSBmb3IgdXBkYXRlOiAke2ZpZWxkTmFtZX1gXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCB1cGRhdGVPcGVyYXRpb24gaW4gdXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZVt1cGRhdGVPcGVyYXRpb25dICYmXG4gICAgICAgICAgICAgICAgICAgIHR5cGVvZiB1cGRhdGVbdXBkYXRlT3BlcmF0aW9uXSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgICAgICAgICAgICAgT2JqZWN0LmtleXModXBkYXRlW3VwZGF0ZU9wZXJhdGlvbl0pLnNvbWUoXG4gICAgICAgICAgICAgICAgICAgICAgaW5uZXJLZXkgPT5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlubmVyS2V5LmluY2x1ZGVzKCckJykgfHwgaW5uZXJLZXkuaW5jbHVkZXMoJy4nKVxuICAgICAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfTkVTVEVEX0tFWSxcbiAgICAgICAgICAgICAgICAgICAgICBcIk5lc3RlZCBrZXlzIHNob3VsZCBub3QgY29udGFpbiB0aGUgJyQnIG9yICcuJyBjaGFyYWN0ZXJzXCJcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdXBkYXRlID0gdHJhbnNmb3JtT2JqZWN0QUNMKHVwZGF0ZSk7XG4gICAgICAgICAgICAgICAgdHJhbnNmb3JtQXV0aERhdGEoY2xhc3NOYW1lLCB1cGRhdGUsIHNjaGVtYSk7XG4gICAgICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgICAgICAgICAgICAgICAuZmluZChjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHt9KVxuICAgICAgICAgICAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGlmICghcmVzdWx0IHx8ICFyZXN1bHQubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7fTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChtYW55KSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLnVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh1cHNlcnQpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZSxcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZmluZE9uZUFuZFVwZGF0ZShcbiAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbigocmVzdWx0OiBhbnkpID0+IHtcbiAgICAgICAgICAgIGlmICghcmVzdWx0KSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgICAgICdPYmplY3Qgbm90IGZvdW5kLidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBvcmlnaW5hbFF1ZXJ5Lm9iamVjdElkLFxuICAgICAgICAgICAgICB1cGRhdGUsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgICAgIGlmIChza2lwU2FuaXRpemF0aW9uKSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzYW5pdGl6ZURhdGFiYXNlUmVzdWx0KG9yaWdpbmFsVXBkYXRlLCByZXN1bHQpO1xuICAgICAgICAgIH0pO1xuICAgICAgfVxuICAgICk7XG4gIH1cblxuICAvLyBDb2xsZWN0IGFsbCByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBsaXN0IG9mIGFsbCByZWxhdGlvbiB1cGRhdGVzIHRvIHBlcmZvcm1cbiAgLy8gVGhpcyBtdXRhdGVzIHVwZGF0ZS5cbiAgY29sbGVjdFJlbGF0aW9uVXBkYXRlcyhjbGFzc05hbWU6IHN0cmluZywgb2JqZWN0SWQ6ID9zdHJpbmcsIHVwZGF0ZTogYW55KSB7XG4gICAgdmFyIG9wcyA9IFtdO1xuICAgIHZhciBkZWxldGVNZSA9IFtdO1xuICAgIG9iamVjdElkID0gdXBkYXRlLm9iamVjdElkIHx8IG9iamVjdElkO1xuXG4gICAgdmFyIHByb2Nlc3MgPSAob3AsIGtleSkgPT4ge1xuICAgICAgaWYgKCFvcCkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAob3AuX19vcCA9PSAnQWRkUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIG9wcy5wdXNoKHsga2V5LCBvcCB9KTtcbiAgICAgICAgZGVsZXRlTWUucHVzaChrZXkpO1xuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnQmF0Y2gnKSB7XG4gICAgICAgIGZvciAodmFyIHggb2Ygb3Aub3BzKSB7XG4gICAgICAgICAgcHJvY2Vzcyh4LCBrZXkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfTtcblxuICAgIGZvciAoY29uc3Qga2V5IGluIHVwZGF0ZSkge1xuICAgICAgcHJvY2Vzcyh1cGRhdGVba2V5XSwga2V5KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBrZXkgb2YgZGVsZXRlTWUpIHtcbiAgICAgIGRlbGV0ZSB1cGRhdGVba2V5XTtcbiAgICB9XG4gICAgcmV0dXJuIG9wcztcbiAgfVxuXG4gIC8vIFByb2Nlc3NlcyByZWxhdGlvbi11cGRhdGluZyBvcGVyYXRpb25zIGZyb20gYSBSRVNULWZvcm1hdCB1cGRhdGUuXG4gIC8vIFJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBhbGwgdXBkYXRlcyBoYXZlIGJlZW4gcGVyZm9ybWVkXG4gIGhhbmRsZVJlbGF0aW9uVXBkYXRlcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBvYmplY3RJZDogc3RyaW5nLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIG9wczogYW55XG4gICkge1xuICAgIHZhciBwZW5kaW5nID0gW107XG4gICAgb2JqZWN0SWQgPSB1cGRhdGUub2JqZWN0SWQgfHwgb2JqZWN0SWQ7XG4gICAgb3BzLmZvckVhY2goKHsga2V5LCBvcCB9KSA9PiB7XG4gICAgICBpZiAoIW9wKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChvcC5fX29wID09ICdBZGRSZWxhdGlvbicpIHtcbiAgICAgICAgZm9yIChjb25zdCBvYmplY3Qgb2Ygb3Aub2JqZWN0cykge1xuICAgICAgICAgIHBlbmRpbmcucHVzaChcbiAgICAgICAgICAgIHRoaXMuYWRkUmVsYXRpb24oa2V5LCBjbGFzc05hbWUsIG9iamVjdElkLCBvYmplY3Qub2JqZWN0SWQpXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAob3AuX19vcCA9PSAnUmVtb3ZlUmVsYXRpb24nKSB7XG4gICAgICAgIGZvciAoY29uc3Qgb2JqZWN0IG9mIG9wLm9iamVjdHMpIHtcbiAgICAgICAgICBwZW5kaW5nLnB1c2goXG4gICAgICAgICAgICB0aGlzLnJlbW92ZVJlbGF0aW9uKGtleSwgY2xhc3NOYW1lLCBvYmplY3RJZCwgb2JqZWN0Lm9iamVjdElkKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBQcm9taXNlLmFsbChwZW5kaW5nKTtcbiAgfVxuXG4gIC8vIEFkZHMgYSByZWxhdGlvbi5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyBzdWNjZXNzZnVsbHkgaWZmIHRoZSBhZGQgd2FzIHN1Y2Nlc3NmdWwuXG4gIGFkZFJlbGF0aW9uKFxuICAgIGtleTogc3RyaW5nLFxuICAgIGZyb21DbGFzc05hbWU6IHN0cmluZyxcbiAgICBmcm9tSWQ6IHN0cmluZyxcbiAgICB0b0lkOiBzdHJpbmdcbiAgKSB7XG4gICAgY29uc3QgZG9jID0ge1xuICAgICAgcmVsYXRlZElkOiB0b0lkLFxuICAgICAgb3duaW5nSWQ6IGZyb21JZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXIudXBzZXJ0T25lT2JqZWN0KFxuICAgICAgYF9Kb2luOiR7a2V5fToke2Zyb21DbGFzc05hbWV9YCxcbiAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgZG9jLFxuICAgICAgZG9jLFxuICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICApO1xuICB9XG5cbiAgLy8gUmVtb3ZlcyBhIHJlbGF0aW9uLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIHJlbW92ZSB3YXNcbiAgLy8gc3VjY2Vzc2Z1bC5cbiAgcmVtb3ZlUmVsYXRpb24oXG4gICAga2V5OiBzdHJpbmcsXG4gICAgZnJvbUNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGZyb21JZDogc3RyaW5nLFxuICAgIHRvSWQ6IHN0cmluZ1xuICApIHtcbiAgICB2YXIgZG9jID0ge1xuICAgICAgcmVsYXRlZElkOiB0b0lkLFxuICAgICAgb3duaW5nSWQ6IGZyb21JZCxcbiAgICB9O1xuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5kZWxldGVPYmplY3RzQnlRdWVyeShcbiAgICAgICAgYF9Kb2luOiR7a2V5fToke2Zyb21DbGFzc05hbWV9YCxcbiAgICAgICAgcmVsYXRpb25TY2hlbWEsXG4gICAgICAgIGRvYyxcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIC8vIFdlIGRvbid0IGNhcmUgaWYgdGhleSB0cnkgdG8gZGVsZXRlIGEgbm9uLWV4aXN0ZW50IHJlbGF0aW9uLlxuICAgICAgICBpZiAoZXJyb3IuY29kZSA9PSBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5EKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICAvLyBSZW1vdmVzIG9iamVjdHMgbWF0Y2hlcyB0aGlzIHF1ZXJ5IGZyb20gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIG9iamVjdCB3YXNcbiAgLy8gZGVsZXRlZC5cbiAgLy8gT3B0aW9uczpcbiAgLy8gICBhY2w6ICBhIGxpc3Qgb2Ygc3RyaW5ncy4gSWYgdGhlIG9iamVjdCB0byBiZSB1cGRhdGVkIGhhcyBhbiBBQ0wsXG4gIC8vICAgICAgICAgb25lIG9mIHRoZSBwcm92aWRlZCBzdHJpbmdzIG11c3QgcHJvdmlkZSB0aGUgY2FsbGVyIHdpdGhcbiAgLy8gICAgICAgICB3cml0ZSBwZXJtaXNzaW9ucy5cbiAgZGVzdHJveShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBxdWVyeTogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcblxuICAgIHJldHVybiB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZCh2YWxpZFNjaGVtYUNvbnRyb2xsZXIpLnRoZW4oXG4gICAgICBzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdkZWxldGUnKVxuICAgICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGlmICghaXNNYXN0ZXIpIHtcbiAgICAgICAgICAgIHF1ZXJ5ID0gdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgIHNjaGVtYUNvbnRyb2xsZXIsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgJ2RlbGV0ZScsXG4gICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICBhY2xHcm91cFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcXVlcnkpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsXG4gICAgICAgICAgICAgICAgJ09iamVjdCBub3QgZm91bmQuJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICAvLyBkZWxldGUgYnkgcXVlcnlcbiAgICAgICAgICBpZiAoYWNsKSB7XG4gICAgICAgICAgICBxdWVyeSA9IGFkZFdyaXRlQUNMKHF1ZXJ5LCBhY2wpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2YWxpZGF0ZVF1ZXJ5KHF1ZXJ5KTtcbiAgICAgICAgICByZXR1cm4gc2NoZW1hQ29udHJvbGxlclxuICAgICAgICAgICAgLmdldE9uZVNjaGVtYShjbGFzc05hbWUpXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAvLyBJZiB0aGUgc2NoZW1hIGRvZXNuJ3QgZXhpc3QsIHByZXRlbmQgaXQgZXhpc3RzIHdpdGggbm8gZmllbGRzLiBUaGlzIGJlaGF2aW9yXG4gICAgICAgICAgICAgIC8vIHdpbGwgbGlrZWx5IG5lZWQgcmV2aXNpdGluZy5cbiAgICAgICAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLnRoZW4ocGFyc2VGb3JtYXRTY2hlbWEgPT5cbiAgICAgICAgICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICBwYXJzZUZvcm1hdFNjaGVtYSxcbiAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvblxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICApXG4gICAgICAgICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAgICAgICAvLyBXaGVuIGRlbGV0aW5nIHNlc3Npb25zIHdoaWxlIGNoYW5naW5nIHBhc3N3b3JkcywgZG9uJ3QgdGhyb3cgYW4gZXJyb3IgaWYgdGhleSBkb24ndCBoYXZlIGFueSBzZXNzaW9ucy5cbiAgICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZSA9PT0gJ19TZXNzaW9uJyAmJlxuICAgICAgICAgICAgICAgIGVycm9yLmNvZGUgPT09IFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkRcbiAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7fSk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgKTtcbiAgfVxuXG4gIC8vIEluc2VydHMgYW4gb2JqZWN0IGludG8gdGhlIGRhdGFiYXNlLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHN1Y2Nlc3NmdWxseSBpZmYgdGhlIG9iamVjdCBzYXZlZC5cbiAgY3JlYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIHsgYWNsIH06IFF1ZXJ5T3B0aW9ucyA9IHt9LFxuICAgIHZhbGlkYXRlT25seTogYm9vbGVhbiA9IGZhbHNlLFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgLy8gTWFrZSBhIGNvcHkgb2YgdGhlIG9iamVjdCwgc28gd2UgZG9uJ3QgbXV0YXRlIHRoZSBpbmNvbWluZyBkYXRhLlxuICAgIGNvbnN0IG9yaWdpbmFsT2JqZWN0ID0gb2JqZWN0O1xuICAgIG9iamVjdCA9IHRyYW5zZm9ybU9iamVjdEFDTChvYmplY3QpO1xuXG4gICAgb2JqZWN0LmNyZWF0ZWRBdCA9IHsgaXNvOiBvYmplY3QuY3JlYXRlZEF0LCBfX3R5cGU6ICdEYXRlJyB9O1xuICAgIG9iamVjdC51cGRhdGVkQXQgPSB7IGlzbzogb2JqZWN0LnVwZGF0ZWRBdCwgX190eXBlOiAnRGF0ZScgfTtcblxuICAgIHZhciBpc01hc3RlciA9IGFjbCA9PT0gdW5kZWZpbmVkO1xuICAgIHZhciBhY2xHcm91cCA9IGFjbCB8fCBbXTtcbiAgICBjb25zdCByZWxhdGlvblVwZGF0ZXMgPSB0aGlzLmNvbGxlY3RSZWxhdGlvblVwZGF0ZXMoXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBudWxsLFxuICAgICAgb2JqZWN0XG4gICAgKTtcblxuICAgIHJldHVybiB0aGlzLnZhbGlkYXRlQ2xhc3NOYW1lKGNsYXNzTmFtZSlcbiAgICAgIC50aGVuKCgpID0+IHRoaXMubG9hZFNjaGVtYUlmTmVlZGVkKHZhbGlkU2NoZW1hQ29udHJvbGxlcikpXG4gICAgICAudGhlbihzY2hlbWFDb250cm9sbGVyID0+IHtcbiAgICAgICAgcmV0dXJuIChpc01hc3RlclxuICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICA6IHNjaGVtYUNvbnRyb2xsZXIudmFsaWRhdGVQZXJtaXNzaW9uKGNsYXNzTmFtZSwgYWNsR3JvdXAsICdjcmVhdGUnKVxuICAgICAgICApXG4gICAgICAgICAgLnRoZW4oKCkgPT4gc2NoZW1hQ29udHJvbGxlci5lbmZvcmNlQ2xhc3NFeGlzdHMoY2xhc3NOYW1lKSlcbiAgICAgICAgICAudGhlbigoKSA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgICAgIC50aGVuKHNjaGVtYSA9PiB7XG4gICAgICAgICAgICB0cmFuc2Zvcm1BdXRoRGF0YShjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKTtcbiAgICAgICAgICAgIGZsYXR0ZW5VcGRhdGVPcGVyYXRvcnNGb3JDcmVhdGUob2JqZWN0KTtcbiAgICAgICAgICAgIGlmICh2YWxpZGF0ZU9ubHkpIHtcbiAgICAgICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5jcmVhdGVPYmplY3QoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgU2NoZW1hQ29udHJvbGxlci5jb252ZXJ0U2NoZW1hVG9BZGFwdGVyU2NoZW1hKHNjaGVtYSksXG4gICAgICAgICAgICAgIG9iamVjdCxcbiAgICAgICAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb25cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICAgICAgaWYgKHZhbGlkYXRlT25seSkge1xuICAgICAgICAgICAgICByZXR1cm4gb3JpZ2luYWxPYmplY3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZWxhdGlvblVwZGF0ZXMoXG4gICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgb2JqZWN0Lm9iamVjdElkLFxuICAgICAgICAgICAgICBvYmplY3QsXG4gICAgICAgICAgICAgIHJlbGF0aW9uVXBkYXRlc1xuICAgICAgICAgICAgKS50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgcmV0dXJuIHNhbml0aXplRGF0YWJhc2VSZXN1bHQob3JpZ2luYWxPYmplY3QsIHJlc3VsdC5vcHNbMF0pO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGNhbkFkZEZpZWxkKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9iamVjdDogYW55LFxuICAgIGFjbEdyb3VwOiBzdHJpbmdbXSxcbiAgICBydW5PcHRpb25zOiBRdWVyeU9wdGlvbnNcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY2xhc3NTY2hlbWEgPSBzY2hlbWEuc2NoZW1hRGF0YVtjbGFzc05hbWVdO1xuICAgIGlmICghY2xhc3NTY2hlbWEpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgY29uc3QgZmllbGRzID0gT2JqZWN0LmtleXMob2JqZWN0KTtcbiAgICBjb25zdCBzY2hlbWFGaWVsZHMgPSBPYmplY3Qua2V5cyhjbGFzc1NjaGVtYS5maWVsZHMpO1xuICAgIGNvbnN0IG5ld0tleXMgPSBmaWVsZHMuZmlsdGVyKGZpZWxkID0+IHtcbiAgICAgIC8vIFNraXAgZmllbGRzIHRoYXQgYXJlIHVuc2V0XG4gICAgICBpZiAoXG4gICAgICAgIG9iamVjdFtmaWVsZF0gJiZcbiAgICAgICAgb2JqZWN0W2ZpZWxkXS5fX29wICYmXG4gICAgICAgIG9iamVjdFtmaWVsZF0uX19vcCA9PT0gJ0RlbGV0ZSdcbiAgICAgICkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9XG4gICAgICByZXR1cm4gc2NoZW1hRmllbGRzLmluZGV4T2YoZmllbGQpIDwgMDtcbiAgICB9KTtcbiAgICBpZiAobmV3S2V5cy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyBhZGRzIGEgbWFya2VyIHRoYXQgbmV3IGZpZWxkIGlzIGJlaW5nIGFkZGluZyBkdXJpbmcgdXBkYXRlXG4gICAgICBydW5PcHRpb25zLmFkZHNGaWVsZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IGFjdGlvbiA9IHJ1bk9wdGlvbnMuYWN0aW9uO1xuICAgICAgcmV0dXJuIHNjaGVtYS52YWxpZGF0ZVBlcm1pc3Npb24oY2xhc3NOYW1lLCBhY2xHcm91cCwgJ2FkZEZpZWxkJywgYWN0aW9uKTtcbiAgICB9XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICB9XG5cbiAgLy8gV29uJ3QgZGVsZXRlIGNvbGxlY3Rpb25zIGluIHRoZSBzeXN0ZW0gbmFtZXNwYWNlXG4gIC8qKlxuICAgKiBEZWxldGUgYWxsIGNsYXNzZXMgYW5kIGNsZWFycyB0aGUgc2NoZW1hIGNhY2hlXG4gICAqXG4gICAqIEBwYXJhbSB7Ym9vbGVhbn0gZmFzdCBzZXQgdG8gdHJ1ZSBpZiBpdCdzIG9rIHRvIGp1c3QgZGVsZXRlIHJvd3MgYW5kIG5vdCBpbmRleGVzXG4gICAqIEByZXR1cm5zIHtQcm9taXNlPHZvaWQ+fSB3aGVuIHRoZSBkZWxldGlvbnMgY29tcGxldGVzXG4gICAqL1xuICBkZWxldGVFdmVyeXRoaW5nKGZhc3Q6IGJvb2xlYW4gPSBmYWxzZSk6IFByb21pc2U8YW55PiB7XG4gICAgdGhpcy5zY2hlbWFQcm9taXNlID0gbnVsbDtcbiAgICByZXR1cm4gUHJvbWlzZS5hbGwoW1xuICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZUFsbENsYXNzZXMoZmFzdCksXG4gICAgICB0aGlzLnNjaGVtYUNhY2hlLmNsZWFyKCksXG4gICAgXSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBsaXN0IG9mIHJlbGF0ZWQgaWRzIGdpdmVuIGFuIG93bmluZyBpZC5cbiAgLy8gY2xhc3NOYW1lIGhlcmUgaXMgdGhlIG93bmluZyBjbGFzc05hbWUuXG4gIHJlbGF0ZWRJZHMoXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAga2V5OiBzdHJpbmcsXG4gICAgb3duaW5nSWQ6IHN0cmluZyxcbiAgICBxdWVyeU9wdGlvbnM6IFF1ZXJ5T3B0aW9uc1xuICApOiBQcm9taXNlPEFycmF5PHN0cmluZz4+IHtcbiAgICBjb25zdCB7IHNraXAsIGxpbWl0LCBzb3J0IH0gPSBxdWVyeU9wdGlvbnM7XG4gICAgY29uc3QgZmluZE9wdGlvbnMgPSB7fTtcbiAgICBpZiAoc29ydCAmJiBzb3J0LmNyZWF0ZWRBdCAmJiB0aGlzLmFkYXB0ZXIuY2FuU29ydE9uSm9pblRhYmxlcykge1xuICAgICAgZmluZE9wdGlvbnMuc29ydCA9IHsgX2lkOiBzb3J0LmNyZWF0ZWRBdCB9O1xuICAgICAgZmluZE9wdGlvbnMubGltaXQgPSBsaW1pdDtcbiAgICAgIGZpbmRPcHRpb25zLnNraXAgPSBza2lwO1xuICAgICAgcXVlcnlPcHRpb25zLnNraXAgPSAwO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5hZGFwdGVyXG4gICAgICAuZmluZChcbiAgICAgICAgam9pblRhYmxlTmFtZShjbGFzc05hbWUsIGtleSksXG4gICAgICAgIHJlbGF0aW9uU2NoZW1hLFxuICAgICAgICB7IG93bmluZ0lkIH0sXG4gICAgICAgIGZpbmRPcHRpb25zXG4gICAgICApXG4gICAgICAudGhlbihyZXN1bHRzID0+IHJlc3VsdHMubWFwKHJlc3VsdCA9PiByZXN1bHQucmVsYXRlZElkKSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSBmb3IgYSBsaXN0IG9mIG93bmluZyBpZHMgZ2l2ZW4gc29tZSByZWxhdGVkIGlkcy5cbiAgLy8gY2xhc3NOYW1lIGhlcmUgaXMgdGhlIG93bmluZyBjbGFzc05hbWUuXG4gIG93bmluZ0lkcyhcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBrZXk6IHN0cmluZyxcbiAgICByZWxhdGVkSWRzOiBzdHJpbmdbXVxuICApOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgLmZpbmQoXG4gICAgICAgIGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBrZXkpLFxuICAgICAgICByZWxhdGlvblNjaGVtYSxcbiAgICAgICAgeyByZWxhdGVkSWQ6IHsgJGluOiByZWxhdGVkSWRzIH0gfSxcbiAgICAgICAge31cbiAgICAgIClcbiAgICAgIC50aGVuKHJlc3VsdHMgPT4gcmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5vd25pbmdJZCkpO1xuICB9XG5cbiAgLy8gTW9kaWZpZXMgcXVlcnkgc28gdGhhdCBpdCBubyBsb25nZXIgaGFzICRpbiBvbiByZWxhdGlvbiBmaWVsZHMsIG9yXG4gIC8vIGVxdWFsLXRvLXBvaW50ZXIgY29uc3RyYWludHMgb24gcmVsYXRpb24gZmllbGRzLlxuICAvLyBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gcXVlcnkgaXMgbXV0YXRlZFxuICByZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZTogc3RyaW5nLCBxdWVyeTogYW55LCBzY2hlbWE6IGFueSk6IFByb21pc2U8YW55PiB7XG4gICAgLy8gU2VhcmNoIGZvciBhbiBpbi1yZWxhdGlvbiBvciBlcXVhbC10by1yZWxhdGlvblxuICAgIC8vIE1ha2UgaXQgc2VxdWVudGlhbCBmb3Igbm93LCBub3Qgc3VyZSBvZiBwYXJhbGxlaXphdGlvbiBzaWRlIGVmZmVjdHNcbiAgICBpZiAocXVlcnlbJyRvciddKSB7XG4gICAgICBjb25zdCBvcnMgPSBxdWVyeVsnJG9yJ107XG4gICAgICByZXR1cm4gUHJvbWlzZS5hbGwoXG4gICAgICAgIG9ycy5tYXAoKGFRdWVyeSwgaW5kZXgpID0+IHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5yZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZSwgYVF1ZXJ5LCBzY2hlbWEpLnRoZW4oXG4gICAgICAgICAgICBhUXVlcnkgPT4ge1xuICAgICAgICAgICAgICBxdWVyeVsnJG9yJ11baW5kZXhdID0gYVF1ZXJ5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICk7XG4gICAgICAgIH0pXG4gICAgICApLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHByb21pc2VzID0gT2JqZWN0LmtleXMocXVlcnkpLm1hcChrZXkgPT4ge1xuICAgICAgY29uc3QgdCA9IHNjaGVtYS5nZXRFeHBlY3RlZFR5cGUoY2xhc3NOYW1lLCBrZXkpO1xuICAgICAgaWYgKCF0IHx8IHQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHF1ZXJ5KTtcbiAgICAgIH1cbiAgICAgIGxldCBxdWVyaWVzOiA/KGFueVtdKSA9IG51bGw7XG4gICAgICBpZiAoXG4gICAgICAgIHF1ZXJ5W2tleV0gJiZcbiAgICAgICAgKHF1ZXJ5W2tleV1bJyRpbiddIHx8XG4gICAgICAgICAgcXVlcnlba2V5XVsnJG5lJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldWyckbmluJ10gfHxcbiAgICAgICAgICBxdWVyeVtrZXldLl9fdHlwZSA9PSAnUG9pbnRlcicpXG4gICAgICApIHtcbiAgICAgICAgLy8gQnVpbGQgdGhlIGxpc3Qgb2YgcXVlcmllc1xuICAgICAgICBxdWVyaWVzID0gT2JqZWN0LmtleXMocXVlcnlba2V5XSkubWFwKGNvbnN0cmFpbnRLZXkgPT4ge1xuICAgICAgICAgIGxldCByZWxhdGVkSWRzO1xuICAgICAgICAgIGxldCBpc05lZ2F0aW9uID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGNvbnN0cmFpbnRLZXkgPT09ICdvYmplY3RJZCcpIHtcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMgPSBbcXVlcnlba2V5XS5vYmplY3RJZF07XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckaW4nKSB7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJGluJ10ubWFwKHIgPT4gci5vYmplY3RJZCk7XG4gICAgICAgICAgfSBlbHNlIGlmIChjb25zdHJhaW50S2V5ID09ICckbmluJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gcXVlcnlba2V5XVsnJG5pbiddLm1hcChyID0+IHIub2JqZWN0SWQpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoY29uc3RyYWludEtleSA9PSAnJG5lJykge1xuICAgICAgICAgICAgaXNOZWdhdGlvbiA9IHRydWU7XG4gICAgICAgICAgICByZWxhdGVkSWRzID0gW3F1ZXJ5W2tleV1bJyRuZSddLm9iamVjdElkXTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgaXNOZWdhdGlvbixcbiAgICAgICAgICAgIHJlbGF0ZWRJZHMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBxdWVyaWVzID0gW3sgaXNOZWdhdGlvbjogZmFsc2UsIHJlbGF0ZWRJZHM6IFtdIH1dO1xuICAgICAgfVxuXG4gICAgICAvLyByZW1vdmUgdGhlIGN1cnJlbnQgcXVlcnlLZXkgYXMgd2UgZG9uLHQgbmVlZCBpdCBhbnltb3JlXG4gICAgICBkZWxldGUgcXVlcnlba2V5XTtcbiAgICAgIC8vIGV4ZWN1dGUgZWFjaCBxdWVyeSBpbmRlcGVuZGVudGx5IHRvIGJ1aWxkIHRoZSBsaXN0IG9mXG4gICAgICAvLyAkaW4gLyAkbmluXG4gICAgICBjb25zdCBwcm9taXNlcyA9IHF1ZXJpZXMubWFwKHEgPT4ge1xuICAgICAgICBpZiAoIXEpIHtcbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHRoaXMub3duaW5nSWRzKGNsYXNzTmFtZSwga2V5LCBxLnJlbGF0ZWRJZHMpLnRoZW4oaWRzID0+IHtcbiAgICAgICAgICBpZiAocS5pc05lZ2F0aW9uKSB7XG4gICAgICAgICAgICB0aGlzLmFkZE5vdEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmFkZEluT2JqZWN0SWRzSWRzKGlkcywgcXVlcnkpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG5cbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcykudGhlbigoKSA9PiB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKS50aGVuKCgpID0+IHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocXVlcnkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gTW9kaWZpZXMgcXVlcnkgc28gdGhhdCBpdCBubyBsb25nZXIgaGFzICRyZWxhdGVkVG9cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIHF1ZXJ5IGlzIG11dGF0ZWRcbiAgcmVkdWNlUmVsYXRpb25LZXlzKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAgcXVlcnlPcHRpb25zOiBhbnlcbiAgKTogP1Byb21pc2U8dm9pZD4ge1xuICAgIGlmIChxdWVyeVsnJG9yJ10pIHtcbiAgICAgIHJldHVybiBQcm9taXNlLmFsbChcbiAgICAgICAgcXVlcnlbJyRvciddLm1hcChhUXVlcnkgPT4ge1xuICAgICAgICAgIHJldHVybiB0aGlzLnJlZHVjZVJlbGF0aW9uS2V5cyhjbGFzc05hbWUsIGFRdWVyeSwgcXVlcnlPcHRpb25zKTtcbiAgICAgICAgfSlcbiAgICAgICk7XG4gICAgfVxuXG4gICAgdmFyIHJlbGF0ZWRUbyA9IHF1ZXJ5WyckcmVsYXRlZFRvJ107XG4gICAgaWYgKHJlbGF0ZWRUbykge1xuICAgICAgcmV0dXJuIHRoaXMucmVsYXRlZElkcyhcbiAgICAgICAgcmVsYXRlZFRvLm9iamVjdC5jbGFzc05hbWUsXG4gICAgICAgIHJlbGF0ZWRUby5rZXksXG4gICAgICAgIHJlbGF0ZWRUby5vYmplY3Qub2JqZWN0SWQsXG4gICAgICAgIHF1ZXJ5T3B0aW9uc1xuICAgICAgKVxuICAgICAgICAudGhlbihpZHMgPT4ge1xuICAgICAgICAgIGRlbGV0ZSBxdWVyeVsnJHJlbGF0ZWRUbyddO1xuICAgICAgICAgIHRoaXMuYWRkSW5PYmplY3RJZHNJZHMoaWRzLCBxdWVyeSk7XG4gICAgICAgICAgcmV0dXJuIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKGNsYXNzTmFtZSwgcXVlcnksIHF1ZXJ5T3B0aW9ucyk7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHt9KTtcbiAgICB9XG4gIH1cblxuICBhZGRJbk9iamVjdElkc0lkcyhpZHM6ID9BcnJheTxzdHJpbmc+ID0gbnVsbCwgcXVlcnk6IGFueSkge1xuICAgIGNvbnN0IGlkc0Zyb21TdHJpbmc6ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycgPyBbcXVlcnkub2JqZWN0SWRdIDogbnVsbDtcbiAgICBjb25zdCBpZHNGcm9tRXE6ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckZXEnXSA/IFtxdWVyeS5vYmplY3RJZFsnJGVxJ11dIDogbnVsbDtcbiAgICBjb25zdCBpZHNGcm9tSW46ID9BcnJheTxzdHJpbmc+ID1cbiAgICAgIHF1ZXJ5Lm9iamVjdElkICYmIHF1ZXJ5Lm9iamVjdElkWyckaW4nXSA/IHF1ZXJ5Lm9iamVjdElkWyckaW4nXSA6IG51bGw7XG5cbiAgICAvLyBAZmxvdy1kaXNhYmxlLW5leHRcbiAgICBjb25zdCBhbGxJZHM6IEFycmF5PEFycmF5PHN0cmluZz4+ID0gW1xuICAgICAgaWRzRnJvbVN0cmluZyxcbiAgICAgIGlkc0Zyb21FcSxcbiAgICAgIGlkc0Zyb21JbixcbiAgICAgIGlkcyxcbiAgICBdLmZpbHRlcihsaXN0ID0+IGxpc3QgIT09IG51bGwpO1xuICAgIGNvbnN0IHRvdGFsTGVuZ3RoID0gYWxsSWRzLnJlZHVjZSgobWVtbywgbGlzdCkgPT4gbWVtbyArIGxpc3QubGVuZ3RoLCAwKTtcblxuICAgIGxldCBpZHNJbnRlcnNlY3Rpb24gPSBbXTtcbiAgICBpZiAodG90YWxMZW5ndGggPiAxMjUpIHtcbiAgICAgIGlkc0ludGVyc2VjdGlvbiA9IGludGVyc2VjdC5iaWcoYWxsSWRzKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWRzSW50ZXJzZWN0aW9uID0gaW50ZXJzZWN0KGFsbElkcyk7XG4gICAgfVxuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJGluOiB1bmRlZmluZWQsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHF1ZXJ5Lm9iamVjdElkID09PSAnc3RyaW5nJykge1xuICAgICAgcXVlcnkub2JqZWN0SWQgPSB7XG4gICAgICAgICRpbjogdW5kZWZpbmVkLFxuICAgICAgICAkZXE6IHF1ZXJ5Lm9iamVjdElkLFxuICAgICAgfTtcbiAgICB9XG4gICAgcXVlcnkub2JqZWN0SWRbJyRpbiddID0gaWRzSW50ZXJzZWN0aW9uO1xuXG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgYWRkTm90SW5PYmplY3RJZHNJZHMoaWRzOiBzdHJpbmdbXSA9IFtdLCBxdWVyeTogYW55KSB7XG4gICAgY29uc3QgaWRzRnJvbU5pbiA9XG4gICAgICBxdWVyeS5vYmplY3RJZCAmJiBxdWVyeS5vYmplY3RJZFsnJG5pbiddID8gcXVlcnkub2JqZWN0SWRbJyRuaW4nXSA6IFtdO1xuICAgIGxldCBhbGxJZHMgPSBbLi4uaWRzRnJvbU5pbiwgLi4uaWRzXS5maWx0ZXIobGlzdCA9PiBsaXN0ICE9PSBudWxsKTtcblxuICAgIC8vIG1ha2UgYSBzZXQgYW5kIHNwcmVhZCB0byByZW1vdmUgZHVwbGljYXRlc1xuICAgIGFsbElkcyA9IFsuLi5uZXcgU2V0KGFsbElkcyldO1xuXG4gICAgLy8gTmVlZCB0byBtYWtlIHN1cmUgd2UgZG9uJ3QgY2xvYmJlciBleGlzdGluZyBzaG9ydGhhbmQgJGVxIGNvbnN0cmFpbnRzIG9uIG9iamVjdElkLlxuICAgIGlmICghKCdvYmplY3RJZCcgaW4gcXVlcnkpKSB7XG4gICAgICBxdWVyeS5vYmplY3RJZCA9IHtcbiAgICAgICAgJG5pbjogdW5kZWZpbmVkLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHF1ZXJ5Lm9iamVjdElkID0ge1xuICAgICAgICAkbmluOiB1bmRlZmluZWQsXG4gICAgICAgICRlcTogcXVlcnkub2JqZWN0SWQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHF1ZXJ5Lm9iamVjdElkWyckbmluJ10gPSBhbGxJZHM7XG4gICAgcmV0dXJuIHF1ZXJ5O1xuICB9XG5cbiAgLy8gUnVucyBhIHF1ZXJ5IG9uIHRoZSBkYXRhYmFzZS5cbiAgLy8gUmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB0byBhIGxpc3Qgb2YgaXRlbXMuXG4gIC8vIE9wdGlvbnM6XG4gIC8vICAgc2tpcCAgICBudW1iZXIgb2YgcmVzdWx0cyB0byBza2lwLlxuICAvLyAgIGxpbWl0ICAgbGltaXQgdG8gdGhpcyBudW1iZXIgb2YgcmVzdWx0cy5cbiAgLy8gICBzb3J0ICAgIGFuIG9iamVjdCB3aGVyZSBrZXlzIGFyZSB0aGUgZmllbGRzIHRvIHNvcnQgYnkuXG4gIC8vICAgICAgICAgICB0aGUgdmFsdWUgaXMgKzEgZm9yIGFzY2VuZGluZywgLTEgZm9yIGRlc2NlbmRpbmcuXG4gIC8vICAgY291bnQgICBydW4gYSBjb3VudCBpbnN0ZWFkIG9mIHJldHVybmluZyByZXN1bHRzLlxuICAvLyAgIGFjbCAgICAgcmVzdHJpY3QgdGhpcyBvcGVyYXRpb24gd2l0aCBhbiBBQ0wgZm9yIHRoZSBwcm92aWRlZCBhcnJheVxuICAvLyAgICAgICAgICAgb2YgdXNlciBvYmplY3RJZHMgYW5kIHJvbGVzLiBhY2w6IG51bGwgbWVhbnMgbm8gdXNlci5cbiAgLy8gICAgICAgICAgIHdoZW4gdGhpcyBmaWVsZCBpcyBub3QgcHJlc2VudCwgZG9uJ3QgZG8gYW55dGhpbmcgcmVnYXJkaW5nIEFDTHMuXG4gIC8vICBjYXNlSW5zZW5zaXRpdmUgbWFrZSBzdHJpbmcgY29tcGFyaXNvbnMgY2FzZSBpbnNlbnNpdGl2ZVxuICAvLyBUT0RPOiBtYWtlIHVzZXJJZHMgbm90IG5lZWRlZCBoZXJlLiBUaGUgZGIgYWRhcHRlciBzaG91bGRuJ3Qga25vd1xuICAvLyBhbnl0aGluZyBhYm91dCB1c2VycywgaWRlYWxseS4gVGhlbiwgaW1wcm92ZSB0aGUgZm9ybWF0IG9mIHRoZSBBQ0xcbiAgLy8gYXJnIHRvIHdvcmsgbGlrZSB0aGUgb3RoZXJzLlxuICBmaW5kKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAge1xuICAgICAgc2tpcCxcbiAgICAgIGxpbWl0LFxuICAgICAgYWNsLFxuICAgICAgc29ydCA9IHt9LFxuICAgICAgY291bnQsXG4gICAgICBrZXlzLFxuICAgICAgb3AsXG4gICAgICBkaXN0aW5jdCxcbiAgICAgIHBpcGVsaW5lLFxuICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICBoaW50LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlID0gZmFsc2UsXG4gICAgICBleHBsYWluLFxuICAgIH06IGFueSA9IHt9LFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIHZhbGlkU2NoZW1hQ29udHJvbGxlcjogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgaXNNYXN0ZXIgPSBhY2wgPT09IHVuZGVmaW5lZDtcbiAgICBjb25zdCBhY2xHcm91cCA9IGFjbCB8fCBbXTtcbiAgICBvcCA9XG4gICAgICBvcCB8fFxuICAgICAgKHR5cGVvZiBxdWVyeS5vYmplY3RJZCA9PSAnc3RyaW5nJyAmJiBPYmplY3Qua2V5cyhxdWVyeSkubGVuZ3RoID09PSAxXG4gICAgICAgID8gJ2dldCdcbiAgICAgICAgOiAnZmluZCcpO1xuICAgIC8vIENvdW50IG9wZXJhdGlvbiBpZiBjb3VudGluZ1xuICAgIG9wID0gY291bnQgPT09IHRydWUgPyAnY291bnQnIDogb3A7XG5cbiAgICBsZXQgY2xhc3NFeGlzdHMgPSB0cnVlO1xuICAgIHJldHVybiB0cmFjZVByb21pc2UoXG4gICAgICAnbG9hZFNjaGVtYScsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICB0aGlzLmxvYWRTY2hlbWFJZk5lZWRlZCh2YWxpZFNjaGVtYUNvbnRyb2xsZXIpXG4gICAgKS50aGVuKHNjaGVtYUNvbnRyb2xsZXIgPT4ge1xuICAgICAgLy9BbGxvdyB2b2xhdGlsZSBjbGFzc2VzIGlmIHF1ZXJ5aW5nIHdpdGggTWFzdGVyIChmb3IgX1B1c2hTdGF0dXMpXG4gICAgICAvL1RPRE86IE1vdmUgdm9sYXRpbGUgY2xhc3NlcyBjb25jZXB0IGludG8gbW9uZ28gYWRhcHRlciwgcG9zdGdyZXMgYWRhcHRlciBzaG91bGRuJ3QgY2FyZVxuICAgICAgLy90aGF0IGFwaS5wYXJzZS5jb20gYnJlYWtzIHdoZW4gX1B1c2hTdGF0dXMgZXhpc3RzIGluIG1vbmdvLlxuICAgICAgcmV0dXJuIHRyYWNlUHJvbWlzZShcbiAgICAgICAgJ2dldE9uZVNjaGVtYScsXG4gICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgc2NoZW1hQ29udHJvbGxlci5nZXRPbmVTY2hlbWEoY2xhc3NOYW1lLCBpc01hc3RlcilcbiAgICAgIClcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyBCZWhhdmlvciBmb3Igbm9uLWV4aXN0ZW50IGNsYXNzZXMgaXMga2luZGEgd2VpcmQgb24gUGFyc2UuY29tLiBQcm9iYWJseSBkb2Vzbid0IG1hdHRlciB0b28gbXVjaC5cbiAgICAgICAgICAvLyBGb3Igbm93LCBwcmV0ZW5kIHRoZSBjbGFzcyBleGlzdHMgYnV0IGhhcyBubyBvYmplY3RzLFxuICAgICAgICAgIGlmIChlcnJvciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjbGFzc0V4aXN0cyA9IGZhbHNlO1xuICAgICAgICAgICAgcmV0dXJuIHsgZmllbGRzOiB7fSB9O1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oc2NoZW1hID0+IHtcbiAgICAgICAgICAvLyBQYXJzZS5jb20gdHJlYXRzIHF1ZXJpZXMgb24gX2NyZWF0ZWRfYXQgYW5kIF91cGRhdGVkX2F0IGFzIGlmIHRoZXkgd2VyZSBxdWVyaWVzIG9uIGNyZWF0ZWRBdCBhbmQgdXBkYXRlZEF0LFxuICAgICAgICAgIC8vIHNvIGR1cGxpY2F0ZSB0aGF0IGJlaGF2aW9yIGhlcmUuIElmIGJvdGggYXJlIHNwZWNpZmllZCwgdGhlIGNvcnJlY3QgYmVoYXZpb3IgdG8gbWF0Y2ggUGFyc2UuY29tIGlzIHRvXG4gICAgICAgICAgLy8gdXNlIHRoZSBvbmUgdGhhdCBhcHBlYXJzIGZpcnN0IGluIHRoZSBzb3J0IGxpc3QuXG4gICAgICAgICAgaWYgKHNvcnQuX2NyZWF0ZWRfYXQpIHtcbiAgICAgICAgICAgIHNvcnQuY3JlYXRlZEF0ID0gc29ydC5fY3JlYXRlZF9hdDtcbiAgICAgICAgICAgIGRlbGV0ZSBzb3J0Ll9jcmVhdGVkX2F0O1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc29ydC5fdXBkYXRlZF9hdCkge1xuICAgICAgICAgICAgc29ydC51cGRhdGVkQXQgPSBzb3J0Ll91cGRhdGVkX2F0O1xuICAgICAgICAgICAgZGVsZXRlIHNvcnQuX3VwZGF0ZWRfYXQ7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgcXVlcnlPcHRpb25zID0ge1xuICAgICAgICAgICAgc2tpcCxcbiAgICAgICAgICAgIGxpbWl0LFxuICAgICAgICAgICAgc29ydCxcbiAgICAgICAgICAgIGtleXMsXG4gICAgICAgICAgICByZWFkUHJlZmVyZW5jZSxcbiAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICBjYXNlSW5zZW5zaXRpdmUsXG4gICAgICAgICAgICBleHBsYWluLFxuICAgICAgICAgIH07XG4gICAgICAgICAgT2JqZWN0LmtleXMoc29ydCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5tYXRjaCgvXmF1dGhEYXRhXFwuKFthLXpBLVowLTlfXSspXFwuaWQkLykpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsXG4gICAgICAgICAgICAgICAgYENhbm5vdCBzb3J0IGJ5ICR7ZmllbGROYW1lfWBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHJvb3RGaWVsZE5hbWUgPSBnZXRSb290RmllbGROYW1lKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICBpZiAoIVNjaGVtYUNvbnRyb2xsZXIuZmllbGROYW1lSXNWYWxpZChyb290RmllbGROYW1lKSkge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9LRVlfTkFNRSxcbiAgICAgICAgICAgICAgICBgSW52YWxpZCBmaWVsZCBuYW1lOiAke2ZpZWxkTmFtZX0uYFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIHJldHVybiAoaXNNYXN0ZXJcbiAgICAgICAgICAgID8gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICAgIDogdHJhY2VQcm9taXNlKFxuICAgICAgICAgICAgICAndmFsaWRhdGVQZXJtaXNzaW9uJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLnZhbGlkYXRlUGVybWlzc2lvbihjbGFzc05hbWUsIGFjbEdyb3VwLCBvcClcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgICAgICAudGhlbigoKSA9PlxuICAgICAgICAgICAgICB0cmFjZVByb21pc2UoXG4gICAgICAgICAgICAgICAgJ3JlZHVjZVJlbGF0aW9uS2V5cycsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgIHRoaXMucmVkdWNlUmVsYXRpb25LZXlzKGNsYXNzTmFtZSwgcXVlcnksIHF1ZXJ5T3B0aW9ucylcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgICAgICAgdHJhY2VQcm9taXNlKFxuICAgICAgICAgICAgICAgICdyZWR1Y2VJblJlbGF0aW9uJyxcbiAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgdGhpcy5yZWR1Y2VJblJlbGF0aW9uKGNsYXNzTmFtZSwgcXVlcnksIHNjaGVtYUNvbnRyb2xsZXIpXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgICAgbGV0IHByb3RlY3RlZEZpZWxkcztcbiAgICAgICAgICAgICAgaWYgKCFpc01hc3Rlcikge1xuICAgICAgICAgICAgICAgIHF1ZXJ5ID0gdGhpcy5hZGRQb2ludGVyUGVybWlzc2lvbnMoXG4gICAgICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgIGFjbEdyb3VwXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAvKiBEb24ndCB1c2UgcHJvamVjdGlvbnMgdG8gb3B0aW1pemUgdGhlIHByb3RlY3RlZEZpZWxkcyBzaW5jZSB0aGUgcHJvdGVjdGVkRmllbGRzXG4gICAgICAgICAgICAgICAgICBiYXNlZCBvbiBwb2ludGVyLXBlcm1pc3Npb25zIGFyZSBkZXRlcm1pbmVkIGFmdGVyIHF1ZXJ5aW5nLiBUaGUgZmlsdGVyaW5nIGNhblxuICAgICAgICAgICAgICAgICAgb3ZlcndyaXRlIHRoZSBwcm90ZWN0ZWQgZmllbGRzLiAqL1xuICAgICAgICAgICAgICAgIHByb3RlY3RlZEZpZWxkcyA9IHRoaXMuYWRkUHJvdGVjdGVkRmllbGRzKFxuICAgICAgICAgICAgICAgICAgc2NoZW1hQ29udHJvbGxlcixcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICAgICAgcXVlcnlPcHRpb25zXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICAgICAgICAgICAgaWYgKG9wID09PSAnZ2V0Jykge1xuICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5PQkpFQ1RfTk9UX0ZPVU5ELFxuICAgICAgICAgICAgICAgICAgICAnT2JqZWN0IG5vdCBmb3VuZC4nXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gW107XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICghaXNNYXN0ZXIpIHtcbiAgICAgICAgICAgICAgICBpZiAob3AgPT09ICd1cGRhdGUnIHx8IG9wID09PSAnZGVsZXRlJykge1xuICAgICAgICAgICAgICAgICAgcXVlcnkgPSBhZGRXcml0ZUFDTChxdWVyeSwgYWNsR3JvdXApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBxdWVyeSA9IGFkZFJlYWRBQ0wocXVlcnksIGFjbEdyb3VwKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgdmFsaWRhdGVRdWVyeShxdWVyeSk7XG4gICAgICAgICAgICAgIGlmIChjb3VudCkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiAwO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmNvdW50KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIHJlYWRQcmVmZXJlbmNlLFxuICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgICAgIGhpbnRcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKGRpc3RpbmN0KSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjbGFzc0V4aXN0cykge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIFtdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmRpc3RpbmN0KFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICAgICAgICAgICAgcXVlcnksXG4gICAgICAgICAgICAgICAgICAgIGRpc3RpbmN0XG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSBlbHNlIGlmIChwaXBlbGluZSkge1xuICAgICAgICAgICAgICAgIGlmICghY2xhc3NFeGlzdHMpIHtcbiAgICAgICAgICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlci5hZ2dyZWdhdGUoXG4gICAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgc2NoZW1hLFxuICAgICAgICAgICAgICAgICAgICBwaXBlbGluZSxcbiAgICAgICAgICAgICAgICAgICAgcmVhZFByZWZlcmVuY2UsXG4gICAgICAgICAgICAgICAgICAgIGhpbnQsXG4gICAgICAgICAgICAgICAgICAgIGV4cGxhaW5cbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGVsc2UgaWYgKGV4cGxhaW4pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5hZGFwdGVyLmZpbmQoXG4gICAgICAgICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICAgICAgICBzY2hlbWEsXG4gICAgICAgICAgICAgICAgICBxdWVyeSxcbiAgICAgICAgICAgICAgICAgIHF1ZXJ5T3B0aW9uc1xuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgICAgICAgICAgICAgLmZpbmQoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCBxdWVyeU9wdGlvbnMpXG4gICAgICAgICAgICAgICAgICAudGhlbihvYmplY3RzID0+XG4gICAgICAgICAgICAgICAgICAgIG9iamVjdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgb2JqZWN0ID0gdW50cmFuc2Zvcm1PYmplY3RBQ0wob2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gZmlsdGVyU2Vuc2l0aXZlRGF0YShcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzTWFzdGVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgYWNsR3JvdXAsXG4gICAgICAgICAgICAgICAgICAgICAgICBhdXRoLFxuICAgICAgICAgICAgICAgICAgICAgICAgb3AsXG4gICAgICAgICAgICAgICAgICAgICAgICBzY2hlbWFDb250cm9sbGVyLFxuICAgICAgICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvdGVjdGVkRmllbGRzLFxuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0XG4gICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAgICAgICAgICAgICAgICAgZXJyb3JcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICBkZWxldGVTY2hlbWEoY2xhc3NOYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gdGhpcy5sb2FkU2NoZW1hKHsgY2xlYXJDYWNoZTogdHJ1ZSB9KVxuICAgICAgLnRoZW4oc2NoZW1hQ29udHJvbGxlciA9PiBzY2hlbWFDb250cm9sbGVyLmdldE9uZVNjaGVtYShjbGFzc05hbWUsIHRydWUpKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICByZXR1cm4geyBmaWVsZHM6IHt9IH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAudGhlbigoc2NoZW1hOiBhbnkpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuY29sbGVjdGlvbkV4aXN0cyhjbGFzc05hbWUpXG4gICAgICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgICAgIHRoaXMuYWRhcHRlci5jb3VudChjbGFzc05hbWUsIHsgZmllbGRzOiB7fSB9LCBudWxsLCAnJywgZmFsc2UpXG4gICAgICAgICAgKVxuICAgICAgICAgIC50aGVuKGNvdW50ID0+IHtcbiAgICAgICAgICAgIGlmIChjb3VudCA+IDApIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIDI1NSxcbiAgICAgICAgICAgICAgICBgQ2xhc3MgJHtjbGFzc05hbWV9IGlzIG5vdCBlbXB0eSwgY29udGFpbnMgJHtjb3VudH0gb2JqZWN0cywgY2Fubm90IGRyb3Agc2NoZW1hLmBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFkYXB0ZXIuZGVsZXRlQ2xhc3MoY2xhc3NOYW1lKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKHdhc1BhcnNlQ29sbGVjdGlvbiA9PiB7XG4gICAgICAgICAgICBpZiAod2FzUGFyc2VDb2xsZWN0aW9uKSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlbGF0aW9uRmllbGROYW1lcyA9IE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZpbHRlcihcbiAgICAgICAgICAgICAgICBmaWVsZE5hbWUgPT4gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdSZWxhdGlvbidcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFxuICAgICAgICAgICAgICAgIHJlbGF0aW9uRmllbGROYW1lcy5tYXAobmFtZSA9PlxuICAgICAgICAgICAgICAgICAgdGhpcy5hZGFwdGVyLmRlbGV0ZUNsYXNzKGpvaW5UYWJsZU5hbWUoY2xhc3NOYW1lLCBuYW1lKSlcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICkudGhlbigoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gQ29uc3RyYWludHMgcXVlcnkgdXNpbmcgQ0xQJ3MgcG9pbnRlciBwZXJtaXNzaW9ucyAoUFApIGlmIGFueS5cbiAgLy8gMS4gRXRyYWN0IHRoZSB1c2VyIGlkIGZyb20gY2FsbGVyJ3MgQUNMZ3JvdXA7XG4gIC8vIDIuIEV4Y3RyYWN0IGEgbGlzdCBvZiBmaWVsZCBuYW1lcyB0aGF0IGFyZSBQUCBmb3IgdGFyZ2V0IGNvbGxlY3Rpb24gYW5kIG9wZXJhdGlvbjtcbiAgLy8gMy4gQ29uc3RyYWludCB0aGUgb3JpZ2luYWwgcXVlcnkgc28gdGhhdCBlYWNoIFBQIGZpZWxkIG11c3RcbiAgLy8gcG9pbnQgdG8gY2FsbGVyJ3MgaWQgKG9yIGNvbnRhaW4gaXQgaW4gY2FzZSBvZiBQUCBmaWVsZCBiZWluZyBhbiBhcnJheSlcbiAgYWRkUG9pbnRlclBlcm1pc3Npb25zKFxuICAgIHNjaGVtYTogU2NoZW1hQ29udHJvbGxlci5TY2hlbWFDb250cm9sbGVyLFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIG9wZXJhdGlvbjogc3RyaW5nLFxuICAgIHF1ZXJ5OiBhbnksXG4gICAgYWNsR3JvdXA6IGFueVtdID0gW11cbiAgKTogYW55IHtcbiAgICAvLyBDaGVjayBpZiBjbGFzcyBoYXMgcHVibGljIHBlcm1pc3Npb24gZm9yIG9wZXJhdGlvblxuICAgIC8vIElmIHRoZSBCYXNlQ0xQIHBhc3MsIGxldCBnbyB0aHJvdWdoXG4gICAgaWYgKHNjaGVtYS50ZXN0UGVybWlzc2lvbnNGb3JDbGFzc05hbWUoY2xhc3NOYW1lLCBhY2xHcm91cCwgb3BlcmF0aW9uKSkge1xuICAgICAgcmV0dXJuIHF1ZXJ5O1xuICAgIH1cbiAgICBjb25zdCBwZXJtcyA9IHNjaGVtYS5nZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lKTtcblxuICAgIGNvbnN0IHVzZXJBQ0wgPSBhY2xHcm91cC5maWx0ZXIoYWNsID0+IHtcbiAgICAgIHJldHVybiBhY2wuaW5kZXhPZigncm9sZTonKSAhPSAwICYmIGFjbCAhPSAnKic7XG4gICAgfSk7XG5cbiAgICBjb25zdCBncm91cEtleSA9XG4gICAgICBbJ2dldCcsICdmaW5kJywgJ2NvdW50J10uaW5kZXhPZihvcGVyYXRpb24pID4gLTFcbiAgICAgICAgPyAncmVhZFVzZXJGaWVsZHMnXG4gICAgICAgIDogJ3dyaXRlVXNlckZpZWxkcyc7XG5cbiAgICBjb25zdCBwZXJtRmllbGRzID0gW107XG5cbiAgICBpZiAocGVybXNbb3BlcmF0aW9uXSAmJiBwZXJtc1tvcGVyYXRpb25dLnBvaW50ZXJGaWVsZHMpIHtcbiAgICAgIHBlcm1GaWVsZHMucHVzaCguLi5wZXJtc1tvcGVyYXRpb25dLnBvaW50ZXJGaWVsZHMpO1xuICAgIH1cblxuICAgIGlmIChwZXJtc1tncm91cEtleV0pIHtcbiAgICAgIGZvciAoY29uc3QgZmllbGQgb2YgcGVybXNbZ3JvdXBLZXldKSB7XG4gICAgICAgIGlmICghcGVybUZpZWxkcy5pbmNsdWRlcyhmaWVsZCkpIHtcbiAgICAgICAgICBwZXJtRmllbGRzLnB1c2goZmllbGQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIC8vIHRoZSBBQ0wgc2hvdWxkIGhhdmUgZXhhY3RseSAxIHVzZXJcbiAgICBpZiAocGVybUZpZWxkcy5sZW5ndGggPiAwKSB7XG4gICAgICAvLyB0aGUgQUNMIHNob3VsZCBoYXZlIGV4YWN0bHkgMSB1c2VyXG4gICAgICAvLyBObyB1c2VyIHNldCByZXR1cm4gdW5kZWZpbmVkXG4gICAgICAvLyBJZiB0aGUgbGVuZ3RoIGlzID4gMSwgdGhhdCBtZWFucyB3ZSBkaWRuJ3QgZGUtZHVwZSB1c2VycyBjb3JyZWN0bHlcbiAgICAgIGlmICh1c2VyQUNMLmxlbmd0aCAhPSAxKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHVzZXJJZCA9IHVzZXJBQ0xbMF07XG4gICAgICBjb25zdCB1c2VyUG9pbnRlciA9IHtcbiAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgIGNsYXNzTmFtZTogJ19Vc2VyJyxcbiAgICAgICAgb2JqZWN0SWQ6IHVzZXJJZCxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IG9ycyA9IHBlcm1GaWVsZHMuZmxhdE1hcChrZXkgPT4ge1xuICAgICAgICAvLyBjb25zdHJhaW50IGZvciBzaW5nbGUgcG9pbnRlciBzZXR1cFxuICAgICAgICBjb25zdCBxID0ge1xuICAgICAgICAgIFtrZXldOiB1c2VyUG9pbnRlcixcbiAgICAgICAgfTtcbiAgICAgICAgLy8gY29uc3RyYWludCBmb3IgdXNlcnMtYXJyYXkgc2V0dXBcbiAgICAgICAgY29uc3QgcWEgPSB7XG4gICAgICAgICAgW2tleV06IHsgJGFsbDogW3VzZXJQb2ludGVyXSB9LFxuICAgICAgICB9O1xuICAgICAgICAvLyBpZiB3ZSBhbHJlYWR5IGhhdmUgYSBjb25zdHJhaW50IG9uIHRoZSBrZXksIHVzZSB0aGUgJGFuZFxuICAgICAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHF1ZXJ5LCBrZXkpKSB7XG4gICAgICAgICAgcmV0dXJuIFt7ICRhbmQ6IFtxLCBxdWVyeV0gfSwgeyAkYW5kOiBbcWEsIHF1ZXJ5XSB9XTtcbiAgICAgICAgfVxuICAgICAgICAvLyBvdGhlcndpc2UganVzdCBhZGQgdGhlIGNvbnN0YWludFxuICAgICAgICByZXR1cm4gW09iamVjdC5hc3NpZ24oe30sIHF1ZXJ5LCBxKSwgT2JqZWN0LmFzc2lnbih7fSwgcXVlcnksIHFhKV07XG4gICAgICB9KTtcbiAgICAgIHJldHVybiB7ICRvcjogb3JzIH07XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBxdWVyeTtcbiAgICB9XG4gIH1cblxuICBhZGRQcm90ZWN0ZWRGaWVsZHMoXG4gICAgc2NoZW1hOiBTY2hlbWFDb250cm9sbGVyLlNjaGVtYUNvbnRyb2xsZXIsXG4gICAgY2xhc3NOYW1lOiBzdHJpbmcsXG4gICAgcXVlcnk6IGFueSA9IHt9LFxuICAgIGFjbEdyb3VwOiBhbnlbXSA9IFtdLFxuICAgIGF1dGg6IGFueSA9IHt9LFxuICAgIHF1ZXJ5T3B0aW9uczogRnVsbFF1ZXJ5T3B0aW9ucyA9IHt9XG4gICk6IG51bGwgfCBzdHJpbmdbXSB7XG4gICAgY29uc3QgcGVybXMgPSBzY2hlbWEuZ2V0Q2xhc3NMZXZlbFBlcm1pc3Npb25zKGNsYXNzTmFtZSk7XG4gICAgaWYgKCFwZXJtcykgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBwcm90ZWN0ZWRGaWVsZHMgPSBwZXJtcy5wcm90ZWN0ZWRGaWVsZHM7XG4gICAgaWYgKCFwcm90ZWN0ZWRGaWVsZHMpIHJldHVybiBudWxsO1xuXG4gICAgaWYgKGFjbEdyb3VwLmluZGV4T2YocXVlcnkub2JqZWN0SWQpID4gLTEpIHJldHVybiBudWxsO1xuXG4gICAgLy8gZm9yIHF1ZXJpZXMgd2hlcmUgXCJrZXlzXCIgYXJlIHNldCBhbmQgZG8gbm90IGluY2x1ZGUgYWxsICd1c2VyRmllbGQnOntmaWVsZH0sXG4gICAgLy8gd2UgaGF2ZSB0byB0cmFuc3BhcmVudGx5IGluY2x1ZGUgaXQsIGFuZCB0aGVuIHJlbW92ZSBiZWZvcmUgcmV0dXJuaW5nIHRvIGNsaWVudFxuICAgIC8vIEJlY2F1c2UgaWYgc3VjaCBrZXkgbm90IHByb2plY3RlZCB0aGUgcGVybWlzc2lvbiB3b24ndCBiZSBlbmZvcmNlZCBwcm9wZXJseVxuICAgIC8vIFBTIHRoaXMgaXMgY2FsbGVkIHdoZW4gJ2V4Y2x1ZGVLZXlzJyBhbHJlYWR5IHJlZHVjZWQgdG8gJ2tleXMnXG4gICAgY29uc3QgcHJlc2VydmVLZXlzID0gcXVlcnlPcHRpb25zLmtleXM7XG5cbiAgICAvLyB0aGVzZSBhcmUga2V5cyB0aGF0IG5lZWQgdG8gYmUgaW5jbHVkZWQgb25seVxuICAgIC8vIHRvIGJlIGFibGUgdG8gYXBwbHkgcHJvdGVjdGVkRmllbGRzIGJ5IHBvaW50ZXJcbiAgICAvLyBhbmQgdGhlbiB1bnNldCBiZWZvcmUgcmV0dXJuaW5nIHRvIGNsaWVudCAobGF0ZXIgaW4gIGZpbHRlclNlbnNpdGl2ZUZpZWxkcylcbiAgICBjb25zdCBzZXJ2ZXJPbmx5S2V5cyA9IFtdO1xuXG4gICAgY29uc3QgYXV0aGVudGljYXRlZCA9IGF1dGgudXNlcjtcblxuICAgIC8vIG1hcCB0byBhbGxvdyBjaGVjayB3aXRob3V0IGFycmF5IHNlYXJjaFxuICAgIGNvbnN0IHJvbGVzID0gKGF1dGgudXNlclJvbGVzIHx8IFtdKS5yZWR1Y2UoKGFjYywgcikgPT4ge1xuICAgICAgYWNjW3JdID0gcHJvdGVjdGVkRmllbGRzW3JdO1xuICAgICAgcmV0dXJuIGFjYztcbiAgICB9LCB7fSk7XG5cbiAgICAvLyBhcnJheSBvZiBzZXRzIG9mIHByb3RlY3RlZCBmaWVsZHMuIHNlcGFyYXRlIGl0ZW0gZm9yIGVhY2ggYXBwbGljYWJsZSBjcml0ZXJpYVxuICAgIGNvbnN0IHByb3RlY3RlZEtleXNTZXRzID0gW107XG5cbiAgICBmb3IgKGNvbnN0IGtleSBpbiBwcm90ZWN0ZWRGaWVsZHMpIHtcbiAgICAgIC8vIHNraXAgdXNlckZpZWxkc1xuICAgICAgaWYgKGtleS5zdGFydHNXaXRoKCd1c2VyRmllbGQ6JykpIHtcbiAgICAgICAgaWYgKHByZXNlcnZlS2V5cykge1xuICAgICAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGtleS5zdWJzdHJpbmcoMTApO1xuICAgICAgICAgIGlmICghcHJlc2VydmVLZXlzLmluY2x1ZGVzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgIC8vIDEuIHB1dCBpdCB0aGVyZSB0ZW1wb3JhcmlseVxuICAgICAgICAgICAgcXVlcnlPcHRpb25zLmtleXMgJiYgcXVlcnlPcHRpb25zLmtleXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgLy8gMi4gcHJlc2VydmUgaXQgZGVsZXRlIGxhdGVyXG4gICAgICAgICAgICBzZXJ2ZXJPbmx5S2V5cy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBhZGQgcHVibGljIHRpZXJcbiAgICAgIGlmIChrZXkgPT09ICcqJykge1xuICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHByb3RlY3RlZEZpZWxkc1trZXldKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIGlmIChhdXRoZW50aWNhdGVkKSB7XG4gICAgICAgIGlmIChrZXkgPT09ICdhdXRoZW50aWNhdGVkJykge1xuICAgICAgICAgIC8vIGZvciBsb2dnZWQgaW4gdXNlcnNcbiAgICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHByb3RlY3RlZEZpZWxkc1trZXldKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyb2xlc1trZXldICYmIGtleS5zdGFydHNXaXRoKCdyb2xlOicpKSB7XG4gICAgICAgICAgLy8gYWRkIGFwcGxpY2FibGUgcm9sZXNcbiAgICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHJvbGVzW2tleV0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gY2hlY2sgaWYgdGhlcmUncyBhIHJ1bGUgZm9yIGN1cnJlbnQgdXNlcidzIGlkXG4gICAgaWYgKGF1dGhlbnRpY2F0ZWQpIHtcbiAgICAgIGNvbnN0IHVzZXJJZCA9IGF1dGgudXNlci5pZDtcbiAgICAgIGlmIChwZXJtcy5wcm90ZWN0ZWRGaWVsZHNbdXNlcklkXSkge1xuICAgICAgICBwcm90ZWN0ZWRLZXlzU2V0cy5wdXNoKHBlcm1zLnByb3RlY3RlZEZpZWxkc1t1c2VySWRdKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBwcmVzZXJ2ZSBmaWVsZHMgdG8gYmUgcmVtb3ZlZCBiZWZvcmUgc2VuZGluZyByZXNwb25zZSB0byBjbGllbnRcbiAgICBpZiAoc2VydmVyT25seUtleXMubGVuZ3RoID4gMCkge1xuICAgICAgcGVybXMucHJvdGVjdGVkRmllbGRzLnRlbXBvcmFyeUtleXMgPSBzZXJ2ZXJPbmx5S2V5cztcbiAgICB9XG5cbiAgICBsZXQgcHJvdGVjdGVkS2V5cyA9IHByb3RlY3RlZEtleXNTZXRzLnJlZHVjZSgoYWNjLCBuZXh0KSA9PiB7XG4gICAgICBpZiAobmV4dCkge1xuICAgICAgICBhY2MucHVzaCguLi5uZXh0KTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBhY2M7XG4gICAgfSwgW10pO1xuXG4gICAgLy8gaW50ZXJzZWN0IGFsbCBzZXRzIG9mIHByb3RlY3RlZEZpZWxkc1xuICAgIHByb3RlY3RlZEtleXNTZXRzLmZvckVhY2goZmllbGRzID0+IHtcbiAgICAgIGlmIChmaWVsZHMpIHtcbiAgICAgICAgcHJvdGVjdGVkS2V5cyA9IHByb3RlY3RlZEtleXMuZmlsdGVyKHYgPT4gZmllbGRzLmluY2x1ZGVzKHYpKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBwcm90ZWN0ZWRLZXlzO1xuICB9XG5cbiAgY3JlYXRlVHJhbnNhY3Rpb25hbFNlc3Npb24oKSB7XG4gICAgcmV0dXJuIHRoaXMuYWRhcHRlclxuICAgICAgLmNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uKClcbiAgICAgIC50aGVuKHRyYW5zYWN0aW9uYWxTZXNzaW9uID0+IHtcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSB0cmFuc2FjdGlvbmFsU2Vzc2lvbjtcbiAgICAgIH0pO1xuICB9XG5cbiAgY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24oKSB7XG4gICAgaWYgKCF0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGVyZSBpcyBubyB0cmFuc2FjdGlvbmFsIHNlc3Npb24gdG8gY29tbWl0Jyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5jb21taXRUcmFuc2FjdGlvbmFsU2Vzc2lvbih0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbilcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24gPSBudWxsO1xuICAgICAgfSk7XG4gIH1cblxuICBhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKCkge1xuICAgIGlmICghdGhpcy5fdHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignVGhlcmUgaXMgbm8gdHJhbnNhY3Rpb25hbCBzZXNzaW9uIHRvIGFib3J0Jyk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmFkYXB0ZXJcbiAgICAgIC5hYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRoaXMuX3RyYW5zYWN0aW9uYWxTZXNzaW9uKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICB0aGlzLl90cmFuc2FjdGlvbmFsU2Vzc2lvbiA9IG51bGw7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIFRPRE86IGNyZWF0ZSBpbmRleGVzIG9uIGZpcnN0IGNyZWF0aW9uIG9mIGEgX1VzZXIgb2JqZWN0LiBPdGhlcndpc2UgaXQncyBpbXBvc3NpYmxlIHRvXG4gIC8vIGhhdmUgYSBQYXJzZSBhcHAgd2l0aG91dCBpdCBoYXZpbmcgYSBfVXNlciBjb2xsZWN0aW9uLlxuICBwZXJmb3JtSW5pdGlhbGl6YXRpb24oKSB7XG4gICAgY29uc3QgcmVxdWlyZWRVc2VyRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1VzZXIsXG4gICAgICB9LFxuICAgIH07XG4gICAgY29uc3QgcmVxdWlyZWRSb2xlRmllbGRzID0ge1xuICAgICAgZmllbGRzOiB7XG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX0RlZmF1bHQsXG4gICAgICAgIC4uLlNjaGVtYUNvbnRyb2xsZXIuZGVmYXVsdENvbHVtbnMuX1JvbGUsXG4gICAgICB9LFxuICAgIH07XG5cbiAgICBjb25zdCB1c2VyQ2xhc3NQcm9taXNlID0gdGhpcy5sb2FkU2NoZW1hKCkudGhlbihzY2hlbWEgPT5cbiAgICAgIHNjaGVtYS5lbmZvcmNlQ2xhc3NFeGlzdHMoJ19Vc2VyJylcbiAgICApO1xuICAgIGNvbnN0IHJvbGVDbGFzc1Byb21pc2UgPSB0aGlzLmxvYWRTY2hlbWEoKS50aGVuKHNjaGVtYSA9PlxuICAgICAgc2NoZW1hLmVuZm9yY2VDbGFzc0V4aXN0cygnX1JvbGUnKVxuICAgICk7XG5cbiAgICBjb25zdCB1c2VybmFtZVVuaXF1ZW5lc3MgPSB1c2VyQ2xhc3NQcm9taXNlXG4gICAgICAudGhlbigoKSA9PlxuICAgICAgICB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1VzZXInLCByZXF1aXJlZFVzZXJGaWVsZHMsIFsndXNlcm5hbWUnXSlcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGxvZ2dlci53YXJuKCdVbmFibGUgdG8gZW5zdXJlIHVuaXF1ZW5lc3MgZm9yIHVzZXJuYW1lczogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgdXNlcm5hbWVDYXNlSW5zZW5zaXRpdmVJbmRleCA9IHVzZXJDbGFzc1Byb21pc2VcbiAgICAgIC50aGVuKCgpID0+XG4gICAgICAgIHRoaXMuYWRhcHRlci5lbnN1cmVJbmRleChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHJlcXVpcmVkVXNlckZpZWxkcyxcbiAgICAgICAgICBbJ3VzZXJuYW1lJ10sXG4gICAgICAgICAgJ2Nhc2VfaW5zZW5zaXRpdmVfdXNlcm5hbWUnLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oXG4gICAgICAgICAgJ1VuYWJsZSB0byBjcmVhdGUgY2FzZSBpbnNlbnNpdGl2ZSB1c2VybmFtZSBpbmRleDogJyxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW1haWxVbmlxdWVuZXNzID0gdXNlckNsYXNzUHJvbWlzZVxuICAgICAgLnRoZW4oKCkgPT5cbiAgICAgICAgdGhpcy5hZGFwdGVyLmVuc3VyZVVuaXF1ZW5lc3MoJ19Vc2VyJywgcmVxdWlyZWRVc2VyRmllbGRzLCBbJ2VtYWlsJ10pXG4gICAgICApXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBsb2dnZXIud2FybihcbiAgICAgICAgICAnVW5hYmxlIHRvIGVuc3VyZSB1bmlxdWVuZXNzIGZvciB1c2VyIGVtYWlsIGFkZHJlc3NlczogJyxcbiAgICAgICAgICBlcnJvclxuICAgICAgICApO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgZW1haWxDYXNlSW5zZW5zaXRpdmVJbmRleCA9IHVzZXJDbGFzc1Byb21pc2VcbiAgICAgIC50aGVuKCgpID0+XG4gICAgICAgIHRoaXMuYWRhcHRlci5lbnN1cmVJbmRleChcbiAgICAgICAgICAnX1VzZXInLFxuICAgICAgICAgIHJlcXVpcmVkVXNlckZpZWxkcyxcbiAgICAgICAgICBbJ2VtYWlsJ10sXG4gICAgICAgICAgJ2Nhc2VfaW5zZW5zaXRpdmVfZW1haWwnLFxuICAgICAgICAgIHRydWVcbiAgICAgICAgKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBjcmVhdGUgY2FzZSBpbnNlbnNpdGl2ZSBlbWFpbCBpbmRleDogJywgZXJyb3IpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuXG4gICAgY29uc3Qgcm9sZVVuaXF1ZW5lc3MgPSByb2xlQ2xhc3NQcm9taXNlXG4gICAgICAudGhlbigoKSA9PlxuICAgICAgICB0aGlzLmFkYXB0ZXIuZW5zdXJlVW5pcXVlbmVzcygnX1JvbGUnLCByZXF1aXJlZFJvbGVGaWVsZHMsIFsnbmFtZSddKVxuICAgICAgKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgbG9nZ2VyLndhcm4oJ1VuYWJsZSB0byBlbnN1cmUgdW5pcXVlbmVzcyBmb3Igcm9sZSBuYW1lOiAnLCBlcnJvcik7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG5cbiAgICBjb25zdCBpbmRleFByb21pc2UgPSB0aGlzLmFkYXB0ZXIudXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMoKTtcblxuICAgIC8vIENyZWF0ZSB0YWJsZXMgZm9yIHZvbGF0aWxlIGNsYXNzZXNcbiAgICBjb25zdCBhZGFwdGVySW5pdCA9IHRoaXMuYWRhcHRlci5wZXJmb3JtSW5pdGlhbGl6YXRpb24oe1xuICAgICAgVm9sYXRpbGVDbGFzc2VzU2NoZW1hczogU2NoZW1hQ29udHJvbGxlci5Wb2xhdGlsZUNsYXNzZXNTY2hlbWFzLFxuICAgIH0pO1xuICAgIHJldHVybiBQcm9taXNlLmFsbChbXG4gICAgICB1c2VybmFtZVVuaXF1ZW5lc3MsXG4gICAgICB1c2VybmFtZUNhc2VJbnNlbnNpdGl2ZUluZGV4LFxuICAgICAgZW1haWxVbmlxdWVuZXNzLFxuICAgICAgZW1haWxDYXNlSW5zZW5zaXRpdmVJbmRleCxcbiAgICAgIHJvbGVVbmlxdWVuZXNzLFxuICAgICAgYWRhcHRlckluaXQsXG4gICAgICBpbmRleFByb21pc2UsXG4gICAgXSk7XG4gIH1cblxuICBzdGF0aWMgX3ZhbGlkYXRlUXVlcnk6IGFueSA9PiB2b2lkO1xufVxuXG5mdW5jdGlvbiB0cmFjZVByb21pc2Uob3BlcmF0aW9uLCBjbGFzc05hbWUsIHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUoKSkge1xuICAvLyBUZW1wb3JhcnkgcmVtb3ZpbmcgdHJhY2UgaGVyZVxuICByZXR1cm4gcHJvbWlzZTtcbiAgLy8gY29uc3QgcGFyZW50ID0gQVdTWFJheS5nZXRTZWdtZW50KCk7XG4gIC8vIGlmICghcGFyZW50KSB7XG4gIC8vICAgcmV0dXJuIHByb21pc2U7XG4gIC8vIH1cbiAgLy8gcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgLy8gICBBV1NYUmF5LmNhcHR1cmVBc3luY0Z1bmMoXG4gIC8vICAgICBgUGFyc2UtU2VydmVyX0RhdGFiYXNlQ3RybF8ke29wZXJhdGlvbn1fJHtjbGFzc05hbWV9YCxcbiAgLy8gICAgIHN1YnNlZ21lbnQgPT4ge1xuICAvLyAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuYWRkQW5ub3RhdGlvbignQ29udHJvbGxlcicsICdEYXRhYmFzZUN0cmwnKTtcbiAgLy8gICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ09wZXJhdGlvbicsIG9wZXJhdGlvbik7XG4gIC8vICAgICAgIGNsYXNzTmFtZSAmIHN1YnNlZ21lbnQgJiZcbiAgLy8gICAgICAgICBzdWJzZWdtZW50LmFkZEFubm90YXRpb24oJ0NsYXNzTmFtZScsIGNsYXNzTmFtZSk7XG4gIC8vICAgICAgIChwcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZSA/IHByb21pc2UgOiBQcm9taXNlLnJlc29sdmUocHJvbWlzZSkpLnRoZW4oXG4gIC8vICAgICAgICAgZnVuY3Rpb24ocmVzdWx0KSB7XG4gIC8vICAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gIC8vICAgICAgICAgICBzdWJzZWdtZW50ICYmIHN1YnNlZ21lbnQuY2xvc2UoKTtcbiAgLy8gICAgICAgICB9LFxuICAvLyAgICAgICAgIGZ1bmN0aW9uKGVycm9yKSB7XG4gIC8vICAgICAgICAgICByZWplY3QoZXJyb3IpO1xuICAvLyAgICAgICAgICAgc3Vic2VnbWVudCAmJiBzdWJzZWdtZW50LmNsb3NlKGVycm9yKTtcbiAgLy8gICAgICAgICB9XG4gIC8vICAgICAgICk7XG4gIC8vICAgICB9XG4gIC8vICAgKTtcbiAgLy8gfSk7XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRGF0YWJhc2VDb250cm9sbGVyO1xuLy8gRXhwb3NlIHZhbGlkYXRlUXVlcnkgZm9yIHRlc3RzXG5tb2R1bGUuZXhwb3J0cy5fdmFsaWRhdGVRdWVyeSA9IHZhbGlkYXRlUXVlcnk7XG4iXX0=