'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PostgresStorageAdapter = undefined;

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };
// -disable-next

// -disable-next


var _PostgresClient = require('./PostgresClient');

var _node = require('parse/node');

var _node2 = _interopRequireDefault(_node);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _sql = require('./sql');

var _sql2 = _interopRequireDefault(_sql);

var _StorageAdapter = require('../StorageAdapter');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const PostgresRelationDoesNotExistError = '42P01';
const PostgresDuplicateRelationError = '42P07';
const PostgresDuplicateColumnError = '42701';
const PostgresMissingColumnError = '42703';
const PostgresDuplicateObjectError = '42710';
const PostgresUniqueIndexViolationError = '23505';
const PostgresTransactionAbortedError = '25P02';
const logger = require('../../../logger');

const debug = function (...args) {
  args = ['PG: ' + arguments[0]].concat(args.slice(1, args.length));
  const log = logger.getLogger();
  log.debug.apply(log, args);
};

const parseTypeToPostgresType = type => {
  switch (type.type) {
    case 'String':
      return 'text';
    case 'Date':
      return 'timestamp with time zone';
    case 'Object':
      return 'jsonb';
    case 'File':
      return 'text';
    case 'Boolean':
      return 'boolean';
    case 'Pointer':
      return 'char(10)';
    case 'Number':
      return 'double precision';
    case 'GeoPoint':
      return 'point';
    case 'Bytes':
      return 'jsonb';
    case 'Polygon':
      return 'polygon';
    case 'Array':
      if (type.contents && type.contents.type === 'String') {
        return 'text[]';
      } else {
        return 'jsonb';
      }
    default:
      throw `no type for ${JSON.stringify(type)} yet`;
  }
};

const ParseToPosgresComparator = {
  '$gt': '>',
  '$lt': '<',
  '$gte': '>=',
  '$lte': '<='
};

const mongoAggregateToPostgres = {
  $dayOfMonth: 'DAY',
  $dayOfWeek: 'DOW',
  $dayOfYear: 'DOY',
  $isoDayOfWeek: 'ISODOW',
  $isoWeekYear: 'ISOYEAR',
  $hour: 'HOUR',
  $minute: 'MINUTE',
  $second: 'SECOND',
  $millisecond: 'MILLISECONDS',
  $month: 'MONTH',
  $week: 'WEEK',
  $year: 'YEAR'
};

const toPostgresValue = value => {
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      return value.iso;
    }
    if (value.__type === 'File') {
      return value.name;
    }
  }
  return value;
};

const transformValue = value => {
  if (typeof value === 'object' && value.__type === 'Pointer') {
    return value.objectId;
  }
  return value;
};

// Duplicate from then mongo adapter...
const emptyCLPS = Object.freeze({
  find: {},
  get: {},
  create: {},
  update: {},
  delete: {},
  addField: {}
});

const defaultCLPS = Object.freeze({
  find: { '*': true },
  get: { '*': true },
  create: { '*': true },
  update: { '*': true },
  delete: { '*': true },
  addField: { '*': true }
});

const toParseSchema = schema => {
  if (schema.className === '_User') {
    delete schema.fields._hashed_password;
  }
  if (schema.fields) {
    delete schema.fields._wperm;
    delete schema.fields._rperm;
  }
  let clps = defaultCLPS;
  if (schema.classLevelPermissions) {
    clps = _extends({}, emptyCLPS, schema.classLevelPermissions);
  }
  let indexes = {};
  if (schema.indexes) {
    indexes = _extends({}, schema.indexes);
  }
  return {
    className: schema.className,
    fields: schema.fields,
    classLevelPermissions: clps,
    indexes
  };
};

const toPostgresSchema = schema => {
  if (!schema) {
    return schema;
  }
  schema.fields = schema.fields || {};
  schema.fields._wperm = { type: 'Array', contents: { type: 'String' } };
  schema.fields._rperm = { type: 'Array', contents: { type: 'String' } };
  if (schema.className === '_User') {
    schema.fields._hashed_password = { type: 'String' };
    schema.fields._password_history = { type: 'Array' };
  }
  return schema;
};

const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      /* eslint-disable no-cond-assign */
      while (next = components.shift()) {
        /* eslint-enable no-cond-assign */
        currentObj[next] = currentObj[next] || {};
        if (components.length === 0) {
          currentObj[next] = value;
        }
        currentObj = currentObj[next];
      }
      delete object[fieldName];
    }
  });
  return object;
};

const transformDotFieldToComponents = fieldName => {
  return fieldName.split('.').map((cmpt, index) => {
    if (index === 0) {
      return `"${cmpt}"`;
    }
    return `'${cmpt}'`;
  });
};

const transformDotField = fieldName => {
  if (fieldName.indexOf('.') === -1) {
    return `"${fieldName}"`;
  }
  const components = transformDotFieldToComponents(fieldName);
  let name = components.slice(0, components.length - 1).join('->');
  name += '->>' + components[components.length - 1];
  return name;
};

const transformAggregateField = fieldName => {
  if (typeof fieldName !== 'string') {
    return fieldName;
  }
  if (fieldName === '$_created_at') {
    return 'createdAt';
  }
  if (fieldName === '$_updated_at') {
    return 'updatedAt';
  }
  return fieldName.substr(1);
};

const validateKeys = object => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }

      if (key.includes('$') || key.includes('.')) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
      }
    }
  }
};

// Returns the list of join tables on a schema
const joinTablesForSchema = schema => {
  const list = [];
  if (schema) {
    Object.keys(schema.fields).forEach(field => {
      if (schema.fields[field].type === 'Relation') {
        list.push(`_Join:${field}:${schema.className}`);
      }
    });
  }
  return list;
};

const buildWhereClause = ({ schema, query, index }) => {
  const patterns = [];
  let values = [];
  const sorts = [];

  schema = toPostgresSchema(schema);
  for (const fieldName in query) {
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName];

    // nothingin the schema, it's gonna blow up
    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }

    if (fieldName.indexOf('.') >= 0) {
      let name = transformDotField(fieldName);
      if (fieldValue === null) {
        patterns.push(`${name} IS NULL`);
      } else {
        if (fieldValue.$in) {
          const inPatterns = [];
          name = transformDotFieldToComponents(fieldName).join('->');
          fieldValue.$in.forEach(listElem => {
            if (typeof listElem === 'string') {
              inPatterns.push(`"${listElem}"`);
            } else {
              inPatterns.push(`${listElem}`);
            }
          });
          patterns.push(`(${name})::jsonb @> '[${inPatterns.join()}]'::jsonb`);
        } else if (fieldValue.$regex) {
          // Handle later
        } else {
          patterns.push(`${name} = '${fieldValue}'`);
        }
      }
    } else if (fieldValue === null || fieldValue === undefined) {
      patterns.push(`$${index}:name IS NULL`);
      values.push(fieldName);
      index += 1;
      continue;
    } else if (typeof fieldValue === 'string') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (typeof fieldValue === 'boolean') {
      patterns.push(`$${index}:name = $${index + 1}`);
      // Can't cast boolean to double precision
      if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Number') {
        // Should always return zero results
        const MAX_INT_PLUS_ONE = 9223372036854775808;
        values.push(fieldName, MAX_INT_PLUS_ONE);
      } else {
        values.push(fieldName, fieldValue);
      }
      index += 2;
    } else if (typeof fieldValue === 'number') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (['$or', '$nor', '$and'].includes(fieldName)) {
      const clauses = [];
      const clauseValues = [];
      fieldValue.forEach(subQuery => {
        const clause = buildWhereClause({ schema, query: subQuery, index });
        if (clause.pattern.length > 0) {
          clauses.push(clause.pattern);
          clauseValues.push(...clause.values);
          index += clause.values.length;
        }
      });

      const orOrAnd = fieldName === '$and' ? ' AND ' : ' OR ';
      const not = fieldName === '$nor' ? ' NOT ' : '';

      patterns.push(`${not}(${clauses.join(orOrAnd)})`);
      values.push(...clauseValues);
    }

    if (fieldValue.$ne !== undefined) {
      if (isArrayField) {
        fieldValue.$ne = JSON.stringify([fieldValue.$ne]);
        patterns.push(`NOT array_contains($${index}:name, $${index + 1})`);
      } else {
        if (fieldValue.$ne === null) {
          patterns.push(`$${index}:name IS NOT NULL`);
          values.push(fieldName);
          index += 1;
          continue;
        } else {
          // if not null, we need to manually exclude null
          patterns.push(`($${index}:name <> $${index + 1} OR $${index}:name IS NULL)`);
        }
      }

      // TODO: support arrays
      values.push(fieldName, fieldValue.$ne);
      index += 2;
    }
    if (fieldValue.$eq !== undefined) {
      if (fieldValue.$eq === null) {
        patterns.push(`$${index}:name IS NULL`);
        values.push(fieldName);
        index += 1;
      } else {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.$eq);
        index += 2;
      }
    }
    const isInOrNin = Array.isArray(fieldValue.$in) || Array.isArray(fieldValue.$nin);
    if (Array.isArray(fieldValue.$in) && isArrayField && schema.fields[fieldName].contents && schema.fields[fieldName].contents.type === 'String') {
      const inPatterns = [];
      let allowNull = false;
      values.push(fieldName);
      fieldValue.$in.forEach((listElem, listIndex) => {
        if (listElem === null) {
          allowNull = true;
        } else {
          values.push(listElem);
          inPatterns.push(`$${index + 1 + listIndex - (allowNull ? 1 : 0)}`);
        }
      });
      if (allowNull) {
        patterns.push(`($${index}:name IS NULL OR $${index}:name && ARRAY[${inPatterns.join()}])`);
      } else {
        patterns.push(`$${index}:name && ARRAY[${inPatterns.join()}]`);
      }
      index = index + 1 + inPatterns.length;
    } else if (isInOrNin) {
      var createConstraint = (baseArray, notIn) => {
        if (baseArray.length > 0) {
          const not = notIn ? ' NOT ' : '';
          if (isArrayField) {
            patterns.push(`${not} array_contains($${index}:name, $${index + 1})`);
            values.push(fieldName, JSON.stringify(baseArray));
            index += 2;
          } else {
            // Handle Nested Dot Notation Above
            if (fieldName.indexOf('.') >= 0) {
              return;
            }
            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              if (listElem !== null) {
                values.push(listElem);
                inPatterns.push(`$${index + 1 + listIndex}`);
              }
            });
            patterns.push(`$${index}:name ${not} IN (${inPatterns.join()})`);
            index = index + 1 + inPatterns.length;
          }
        } else if (!notIn) {
          values.push(fieldName);
          patterns.push(`$${index}:name IS NULL`);
          index = index + 1;
        }
      };
      if (fieldValue.$in) {
        createConstraint(_lodash2.default.flatMap(fieldValue.$in, elt => elt), false);
      }
      if (fieldValue.$nin) {
        createConstraint(_lodash2.default.flatMap(fieldValue.$nin, elt => elt), true);
      }
    } else if (typeof fieldValue.$in !== 'undefined') {
      throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $in value');
    } else if (typeof fieldValue.$nin !== 'undefined') {
      throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $nin value');
    }

    if (Array.isArray(fieldValue.$all) && isArrayField) {
      if (isAnyValueRegexStartsWith(fieldValue.$all)) {
        if (!isAllValuesRegexOrNone(fieldValue.$all)) {
          throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'All $all values must be of regex type or none: ' + fieldValue.$all);
        }

        for (let i = 0; i < fieldValue.$all.length; i += 1) {
          const value = processRegexPattern(fieldValue.$all[i].$regex);
          fieldValue.$all[i] = value.substring(1) + '%';
        }
        patterns.push(`array_contains_all_regex($${index}:name, $${index + 1}::jsonb)`);
      } else {
        patterns.push(`array_contains_all($${index}:name, $${index + 1}::jsonb)`);
      }
      values.push(fieldName, JSON.stringify(fieldValue.$all));
      index += 2;
    }

    if (typeof fieldValue.$exists !== 'undefined') {
      if (fieldValue.$exists) {
        patterns.push(`$${index}:name IS NOT NULL`);
      } else {
        patterns.push(`$${index}:name IS NULL`);
      }
      values.push(fieldName);
      index += 1;
    }

    if (fieldValue.$containedBy) {
      const arr = fieldValue.$containedBy;
      if (!(arr instanceof Array)) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $containedBy: should be an array`);
      }

      patterns.push(`$${index}:name <@ $${index + 1}::jsonb`);
      values.push(fieldName, JSON.stringify(arr));
      index += 2;
    }

    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
      let language = 'english';
      if (typeof search !== 'object') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $search, should be object`);
      }
      if (!search.$term || typeof search.$term !== 'string') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $term, should be string`);
      }
      if (search.$language && typeof search.$language !== 'string') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $language, should be string`);
      } else if (search.$language) {
        language = search.$language;
      }
      if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $caseSensitive, should be boolean`);
      } else if (search.$caseSensitive) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $caseSensitive not supported, please use $regex or create a separate lower case column.`);
      }
      if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive, should be boolean`);
      } else if (search.$diacriticSensitive === false) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive - false not supported, install Postgres Unaccent Extension`);
      }
      patterns.push(`to_tsvector($${index}, $${index + 1}:name) @@ to_tsquery($${index + 2}, $${index + 3})`);
      values.push(language, fieldName, language, search.$term);
      index += 4;
    }

    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      const distance = fieldValue.$maxDistance;
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      sorts.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) ASC`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }

    if (fieldValue.$within && fieldValue.$within.$box) {
      const box = fieldValue.$within.$box;
      const left = box[0].longitude;
      const bottom = box[0].latitude;
      const right = box[1].longitude;
      const top = box[1].latitude;

      patterns.push(`$${index}:name::point <@ $${index + 1}::box`);
      values.push(fieldName, `((${left}, ${bottom}), (${right}, ${top}))`);
      index += 2;
    }

    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$centerSphere) {
      const centerSphere = fieldValue.$geoWithin.$centerSphere;
      if (!(centerSphere instanceof Array) || centerSphere.length < 2) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance');
      }
      // Get point, convert to geo point if necessary and validate
      let point = centerSphere[0];
      if (point instanceof Array && point.length === 2) {
        point = new _node2.default.GeoPoint(point[1], point[0]);
      } else if (!GeoPointCoder.isValidJSON(point)) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere geo point invalid');
      }
      _node2.default.GeoPoint._validate(point.latitude, point.longitude);
      // Get distance and validate
      const distance = centerSphere[1];
      if (isNaN(distance) || distance < 0) {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere distance invalid');
      }
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_distance_sphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }

    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$polygon) {
      const polygon = fieldValue.$geoWithin.$polygon;
      let points;
      if (typeof polygon === 'object' && polygon.__type === 'Polygon') {
        if (!polygon.coordinates || polygon.coordinates.length < 3) {
          throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; Polygon.coordinates should contain at least 3 lon/lat pairs');
        }
        points = polygon.coordinates;
      } else if (polygon instanceof Array) {
        if (polygon.length < 3) {
          throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should contain at least 3 GeoPoints');
        }
        points = polygon;
      } else {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint\'s');
      }
      points = points.map(point => {
        if (point instanceof Array && point.length === 2) {
          _node2.default.GeoPoint._validate(point[1], point[0]);
          return `(${point[0]}, ${point[1]})`;
        }
        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          _node2.default.GeoPoint._validate(point.latitude, point.longitude);
        }
        return `(${point.longitude}, ${point.latitude})`;
      }).join(', ');

      patterns.push(`$${index}:name::point <@ $${index + 1}::polygon`);
      values.push(fieldName, `(${points})`);
      index += 2;
    }
    if (fieldValue.$geoIntersects && fieldValue.$geoIntersects.$point) {
      const point = fieldValue.$geoIntersects.$point;
      if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, 'bad $geoIntersect value; $point should be GeoPoint');
      } else {
        _node2.default.GeoPoint._validate(point.latitude, point.longitude);
      }
      patterns.push(`$${index}:name::polygon @> $${index + 1}::point`);
      values.push(fieldName, `(${point.longitude}, ${point.latitude})`);
      index += 2;
    }

    if (fieldValue.$regex) {
      let regex = fieldValue.$regex;
      let operator = '~';
      const opts = fieldValue.$options;
      if (opts) {
        if (opts.indexOf('i') >= 0) {
          operator = '~*';
        }
        if (opts.indexOf('x') >= 0) {
          regex = removeWhiteSpace(regex);
        }
      }

      const name = transformDotField(fieldName);
      regex = processRegexPattern(regex);

      patterns.push(`$${index}:raw ${operator} '$${index + 1}:raw'`);
      values.push(name, regex);
      index += 2;
    }

    if (fieldValue.__type === 'Pointer') {
      if (isArrayField) {
        patterns.push(`array_contains($${index}:name, $${index + 1})`);
        values.push(fieldName, JSON.stringify([fieldValue]));
        index += 2;
      } else {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      }
    }

    if (fieldValue.__type === 'Date') {
      patterns.push(`$${index}:name = $${index + 1}`);
      values.push(fieldName, fieldValue.iso);
      index += 2;
    }

    if (fieldValue.__type === 'GeoPoint') {
      patterns.push('$' + index + ':name ~= POINT($' + (index + 1) + ', $' + (index + 2) + ')');
      values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
      index += 3;
    }

    if (fieldValue.__type === 'Polygon') {
      const value = convertPolygonToSQL(fieldValue.coordinates);
      patterns.push(`$${index}:name ~= $${index + 1}::polygon`);
      values.push(fieldName, value);
      index += 2;
    }

    Object.keys(ParseToPosgresComparator).forEach(cmp => {
      if (fieldValue[cmp] || fieldValue[cmp] === 0) {
        const pgComparator = ParseToPosgresComparator[cmp];
        patterns.push(`$${index}:name ${pgComparator} $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue[cmp]));
        index += 2;
      }
    });

    if (initialPatternsLength === patterns.length) {
      throw new _node2.default.Error(_node2.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support this query type yet ${JSON.stringify(fieldValue)}`);
    }
  }
  values = values.map(transformValue);
  return { pattern: patterns.join(' AND '), values, sorts };
};

class PostgresStorageAdapter {

  constructor({
    uri,
    collectionPrefix = '',
    databaseOptions
  }) {
    this._collectionPrefix = collectionPrefix;
    const { client, pgp } = (0, _PostgresClient.createClient)(uri, databaseOptions);
    this._client = client;
    this._pgp = pgp;
    this.canSortOnJoinTables = false;
  }

  // Private


  handleShutdown() {
    if (!this._client) {
      return;
    }
    this._client.$pool.end();
  }

  _ensureSchemaCollectionExists(conn) {
    conn = conn || this._client;
    return conn.none('CREATE TABLE IF NOT EXISTS "_SCHEMA" ( "className" varChar(120), "schema" jsonb, "isParseClass" bool, PRIMARY KEY ("className") )').catch(error => {
      if (error.code === PostgresDuplicateRelationError || error.code === PostgresUniqueIndexViolationError || error.code === PostgresDuplicateObjectError) {
        // Table already exists, must have been created by a different request. Ignore error.
      } else {
        throw error;
      }
    });
  }

  classExists(name) {
    return this._client.one('SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)', [name], a => a.exists);
  }

  setClassLevelPermissions(className, CLPs) {
    const self = this;
    return this._client.task('set-class-level-permissions', function* (t) {
      yield self._ensureSchemaCollectionExists(t);
      const values = [className, 'schema', 'classLevelPermissions', JSON.stringify(CLPs)];
      yield t.none(`UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className"=$1`, values);
    });
  }

  setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields, conn) {
    conn = conn || this._client;
    const self = this;
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }
    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = { _id_: { _id: 1 } };
    }
    const deletedIndexes = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];
      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }
      if (field.__op === 'Delete') {
        deletedIndexes.push(name);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!fields.hasOwnProperty(key)) {
            throw new _node2.default.Error(_node2.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    return conn.tx('set-indexes-with-schema-format', function* (t) {
      if (insertedIndexes.length > 0) {
        yield self.createIndexes(className, insertedIndexes, t);
      }
      if (deletedIndexes.length > 0) {
        yield self.dropIndexes(className, deletedIndexes, t);
      }
      yield self._ensureSchemaCollectionExists(t);
      yield t.none('UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className"=$1', [className, 'schema', 'indexes', JSON.stringify(existingIndexes)]);
    });
  }

  createClass(className, schema, conn) {
    conn = conn || this._client;
    return conn.tx('create-class', t => {
      const q1 = this.createTable(className, schema, t);
      const q2 = t.none('INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES ($<className>, $<schema>, true)', { className, schema });
      const q3 = this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields, t);
      return t.batch([q1, q2, q3]);
    }).then(() => {
      return toParseSchema(schema);
    }).catch(err => {
      if (err.data[0].result.code === PostgresTransactionAbortedError) {
        err = err.data[1].result;
      }
      if (err.code === PostgresUniqueIndexViolationError && err.detail.includes(className)) {
        throw new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }
      throw err;
    });
  }

  // Just create a table, do not insert in schema
  createTable(className, schema, conn) {
    conn = conn || this._client;
    const self = this;
    debug('createTable', className, schema);
    const valuesArray = [];
    const patternsArray = [];
    const fields = Object.assign({}, schema.fields);
    if (className === '_User') {
      fields._email_verify_token_expires_at = { type: 'Date' };
      fields._email_verify_token = { type: 'String' };
      fields._account_lockout_expires_at = { type: 'Date' };
      fields._failed_login_count = { type: 'Number' };
      fields._perishable_token = { type: 'String' };
      fields._perishable_token_expires_at = { type: 'Date' };
      fields._password_changed_at = { type: 'Date' };
      fields._password_history = { type: 'Array' };
    }
    let index = 2;
    const relations = [];
    Object.keys(fields).forEach(fieldName => {
      const parseType = fields[fieldName];
      // Skip when it's a relation
      // We'll create the tables later
      if (parseType.type === 'Relation') {
        relations.push(fieldName);
        return;
      }
      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        parseType.contents = { type: 'String' };
      }
      valuesArray.push(fieldName);
      valuesArray.push(parseTypeToPostgresType(parseType));
      patternsArray.push(`$${index}:name $${index + 1}:raw`);
      if (fieldName === 'objectId') {
        patternsArray.push(`PRIMARY KEY ($${index}:name)`);
      }
      index = index + 2;
    });
    const qs = `CREATE TABLE IF NOT EXISTS $1:name (${patternsArray.join()})`;
    const values = [className, ...valuesArray];

    return conn.task('create-table', function* (t) {
      try {
        yield self._ensureSchemaCollectionExists(t);
        yield t.none(qs, values);
      } catch (error) {
        if (error.code !== PostgresDuplicateRelationError) {
          throw error;
        }
        // ELSE: Table already exists, must have been created by a different request. Ignore the error.
      }
      yield t.tx('create-table-tx', tx => {
        return tx.batch(relations.map(fieldName => {
          return tx.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', { joinTable: `_Join:${fieldName}:${className}` });
        }));
      });
    });
  }

  schemaUpgrade(className, schema, conn) {
    debug('schemaUpgrade', { className, schema });
    conn = conn || this._client;
    const self = this;

    return conn.tx('schema-upgrade', function* (t) {
      const columns = yield t.map('SELECT column_name FROM information_schema.columns WHERE table_name = $<className>', { className }, a => a.column_name);
      const newColumns = Object.keys(schema.fields).filter(item => columns.indexOf(item) === -1).map(fieldName => self.addFieldIfNotExists(className, fieldName, schema.fields[fieldName], t));

      yield t.batch(newColumns);
    });
  }

  addFieldIfNotExists(className, fieldName, type, conn) {
    // TODO: Must be revised for invalid logic...
    debug('addFieldIfNotExists', { className, fieldName, type });
    conn = conn || this._client;
    const self = this;
    return conn.tx('add-field-if-not-exists', function* (t) {
      if (type.type !== 'Relation') {
        try {
          yield t.none('ALTER TABLE $<className:name> ADD COLUMN $<fieldName:name> $<postgresType:raw>', {
            className,
            fieldName,
            postgresType: parseTypeToPostgresType(type)
          });
        } catch (error) {
          if (error.code === PostgresRelationDoesNotExistError) {
            return yield self.createClass(className, { fields: { [fieldName]: type } }, t);
          }
          if (error.code !== PostgresDuplicateColumnError) {
            throw error;
          }
          // Column already exists, created by other request. Carry on to see if it's the right type.
        }
      } else {
        yield t.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', { joinTable: `_Join:${fieldName}:${className}` });
      }

      const result = yield t.any('SELECT "schema" FROM "_SCHEMA" WHERE "className" = $<className> and ("schema"::json->\'fields\'->$<fieldName>) is not null', { className, fieldName });

      if (result[0]) {
        throw 'Attempted to add a field that already exists';
      } else {
        const path = `{fields,${fieldName}}`;
        yield t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', { path, type, className });
      }
    });
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  deleteClass(className) {
    const operations = [{ query: `DROP TABLE IF EXISTS $1:name`, values: [className] }, { query: `DELETE FROM "_SCHEMA" WHERE "className" = $1`, values: [className] }];
    return this._client.tx(t => t.none(this._pgp.helpers.concat(operations))).then(() => className.indexOf('_Join:') != 0); // resolves with false when _Join table
  }

  // Delete all data known to this adapter. Used for testing.
  deleteAllClasses() {
    const now = new Date().getTime();
    const helpers = this._pgp.helpers;
    debug('deleteAllClasses');

    return this._client.task('delete-all-classes', function* (t) {
      try {
        const results = yield t.any('SELECT * FROM "_SCHEMA"');
        const joins = results.reduce((list, schema) => {
          return list.concat(joinTablesForSchema(schema.schema));
        }, []);
        const classes = ['_SCHEMA', '_PushStatus', '_JobStatus', '_JobSchedule', '_Hooks', '_GlobalConfig', '_Audience', ...results.map(result => result.className), ...joins];
        const queries = classes.map(className => ({ query: 'DROP TABLE IF EXISTS $<className:name>', values: { className } }));
        yield t.tx(tx => tx.none(helpers.concat(queries)));
      } catch (error) {
        if (error.code !== PostgresRelationDoesNotExistError) {
          throw error;
        }
        // No _SCHEMA collection. Don't delete anything.
      }
    }).then(() => {
      debug(`deleteAllClasses done in ${new Date().getTime() - now}`);
    });
  }

  // Remove the column and all the data. For Relations, the _Join collection is handled
  // specially, this function does not delete _Join columns. It should, however, indicate
  // that the relation fields does not exist anymore. In mongo, this means removing it from
  // the _SCHEMA collection.  There should be no actual data in the collection under the same name
  // as the relation column, so it's fine to attempt to delete it. If the fields listed to be
  // deleted do not exist, this function should return successfully anyways. Checking for
  // attempts to delete non-existent fields is the responsibility of Parse Server.

  // This function is not obligated to delete fields atomically. It is given the field
  // names in a list so that databases that are capable of deleting fields atomically
  // may do so.

  // Returns a Promise.
  deleteFields(className, schema, fieldNames) {
    debug('deleteFields', className, fieldNames);
    fieldNames = fieldNames.reduce((list, fieldName) => {
      const field = schema.fields[fieldName];
      if (field.type !== 'Relation') {
        list.push(fieldName);
      }
      delete schema.fields[fieldName];
      return list;
    }, []);

    const values = [className, ...fieldNames];
    const columns = fieldNames.map((name, idx) => {
      return `$${idx + 2}:name`;
    }).join(', DROP COLUMN');

    return this._client.tx('delete-fields', function* (t) {
      yield t.none('UPDATE "_SCHEMA" SET "schema"=$<schema> WHERE "className"=$<className>', { schema, className });
      if (values.length > 1) {
        yield t.none(`ALTER TABLE $1:name DROP COLUMN ${columns}`, values);
      }
    });
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  getAllClasses() {
    const self = this;
    return this._client.task('get-all-classes', function* (t) {
      yield self._ensureSchemaCollectionExists(t);
      return yield t.map('SELECT * FROM "_SCHEMA"', null, row => toParseSchema(_extends({ className: row.className }, row.schema)));
    });
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  getClass(className) {
    debug('getClass', className);
    return this._client.any('SELECT * FROM "_SCHEMA" WHERE "className"=$<className>', { className }).then(result => {
      if (result.length !== 1) {
        throw undefined;
      }
      return result[0].schema;
    }).then(toParseSchema);
  }

  // TODO: remove the mongo format dependency in the return value
  createObject(className, schema, object) {
    debug('createObject', className, object);
    let columnsArray = [];
    const valuesArray = [];
    schema = toPostgresSchema(schema);
    const geoPoints = {};

    object = handleDotFields(object);

    validateKeys(object);

    Object.keys(object).forEach(fieldName => {
      if (object[fieldName] === null) {
        return;
      }
      var authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      if (authDataMatch) {
        var provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        fieldName = 'authData';
      }

      columnsArray.push(fieldName);
      if (!schema.fields[fieldName] && className === '_User') {
        if (fieldName === '_email_verify_token' || fieldName === '_failed_login_count' || fieldName === '_perishable_token' || fieldName === '_password_history') {
          valuesArray.push(object[fieldName]);
        }

        if (fieldName === '_email_verify_token_expires_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }

        if (fieldName === '_account_lockout_expires_at' || fieldName === '_perishable_token_expires_at' || fieldName === '_password_changed_at') {
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
        }
        return;
      }
      switch (schema.fields[fieldName].type) {
        case 'Date':
          if (object[fieldName]) {
            valuesArray.push(object[fieldName].iso);
          } else {
            valuesArray.push(null);
          }
          break;
        case 'Pointer':
          valuesArray.push(object[fieldName].objectId);
          break;
        case 'Array':
          if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
            valuesArray.push(object[fieldName]);
          } else {
            valuesArray.push(JSON.stringify(object[fieldName]));
          }
          break;
        case 'Object':
        case 'Bytes':
        case 'String':
        case 'Number':
        case 'Boolean':
          valuesArray.push(object[fieldName]);
          break;
        case 'File':
          valuesArray.push(object[fieldName].name);
          break;
        case 'Polygon':
          {
            const value = convertPolygonToSQL(object[fieldName].coordinates);
            valuesArray.push(value);
            break;
          }
        case 'GeoPoint':
          // pop the point and process later
          geoPoints[fieldName] = object[fieldName];
          columnsArray.pop();
          break;
        default:
          throw `Type ${schema.fields[fieldName].type} not supported yet`;
      }
    });

    columnsArray = columnsArray.concat(Object.keys(geoPoints));
    const initialValues = valuesArray.map((val, index) => {
      let termination = '';
      const fieldName = columnsArray[index];
      if (['_rperm', '_wperm'].indexOf(fieldName) >= 0) {
        termination = '::text[]';
      } else if (schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        termination = '::jsonb';
      }
      return `$${index + 2 + columnsArray.length}${termination}`;
    });
    const geoPointsInjects = Object.keys(geoPoints).map(key => {
      const value = geoPoints[key];
      valuesArray.push(value.longitude, value.latitude);
      const l = valuesArray.length + columnsArray.length;
      return `POINT($${l}, $${l + 1})`;
    });

    const columnsPattern = columnsArray.map((col, index) => `$${index + 2}:name`).join();
    const valuesPattern = initialValues.concat(geoPointsInjects).join();

    const qs = `INSERT INTO $1:name (${columnsPattern}) VALUES (${valuesPattern})`;
    const values = [className, ...columnsArray, ...valuesArray];
    debug(qs, values);
    return this._client.none(qs, values).then(() => ({ ops: [object] })).catch(error => {
      if (error.code === PostgresUniqueIndexViolationError) {
        const err = new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.constraint) {
          const matches = error.constraint.match(/unique_([a-zA-Z]+)/);
          if (matches && Array.isArray(matches)) {
            err.userInfo = { duplicated_field: matches[1] };
          }
        }
        error = err;
      }
      throw error;
    });
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  deleteObjectsByQuery(className, schema, query) {
    debug('deleteObjectsByQuery', className, query);
    const values = [className];
    const index = 2;
    const where = buildWhereClause({ schema, index, query });
    values.push(...where.values);
    if (Object.keys(query).length === 0) {
      where.pattern = 'TRUE';
    }
    const qs = `WITH deleted AS (DELETE FROM $1:name WHERE ${where.pattern} RETURNING *) SELECT count(*) FROM deleted`;
    debug(qs, values);
    return this._client.one(qs, values, a => +a.count).then(count => {
      if (count === 0) {
        throw new _node2.default.Error(_node2.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      } else {
        return count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      // ELSE: Don't delete anything if doesn't exist
    });
  }
  // Return value not currently well specified.
  findOneAndUpdate(className, schema, query, update) {
    debug('findOneAndUpdate', className, query, update);
    return this.updateObjectsByQuery(className, schema, query, update).then(val => val[0]);
  }

  // Apply the update to all objects that match the given Parse Query.
  updateObjectsByQuery(className, schema, query, update) {
    debug('updateObjectsByQuery', className, query, update);
    const updatePatterns = [];
    const values = [className];
    let index = 2;
    schema = toPostgresSchema(schema);

    const originalUpdate = _extends({}, update);
    update = handleDotFields(update);
    // Resolve authData first,
    // So we don't end up with multiple key updates
    for (const fieldName in update) {
      const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
      if (authDataMatch) {
        var provider = authDataMatch[1];
        const value = update[fieldName];
        delete update[fieldName];
        update['authData'] = update['authData'] || {};
        update['authData'][provider] = value;
      }
    }

    for (const fieldName in update) {
      const fieldValue = update[fieldName];
      if (fieldValue === null) {
        updatePatterns.push(`$${index}:name = NULL`);
        values.push(fieldName);
        index += 1;
      } else if (fieldName == 'authData') {
        // This recursively sets the json_object
        // Only 1 level deep
        const generate = (jsonb, key, value) => {
          return `json_object_set_key(COALESCE(${jsonb}, '{}'::jsonb), ${key}, ${value})::jsonb`;
        };
        const lastKey = `$${index}:name`;
        const fieldNameIndex = index;
        index += 1;
        values.push(fieldName);
        const update = Object.keys(fieldValue).reduce((lastKey, key) => {
          const str = generate(lastKey, `$${index}::text`, `$${index + 1}::jsonb`);
          index += 2;
          let value = fieldValue[key];
          if (value) {
            if (value.__op === 'Delete') {
              value = null;
            } else {
              value = JSON.stringify(value);
            }
          }
          values.push(key, value);
          return str;
        }, lastKey);
        updatePatterns.push(`$${fieldNameIndex}:name = ${update}`);
      } else if (fieldValue.__op === 'Increment') {
        updatePatterns.push(`$${index}:name = COALESCE($${index}:name, 0) + $${index + 1}`);
        values.push(fieldName, fieldValue.amount);
        index += 2;
      } else if (fieldValue.__op === 'Add') {
        updatePatterns.push(`$${index}:name = array_add(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'Delete') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, null);
        index += 2;
      } else if (fieldValue.__op === 'Remove') {
        updatePatterns.push(`$${index}:name = array_remove(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldValue.__op === 'AddUnique') {
        updatePatterns.push(`$${index}:name = array_add_unique(COALESCE($${index}:name, '[]'::jsonb), $${index + 1}::jsonb)`);
        values.push(fieldName, JSON.stringify(fieldValue.objects));
        index += 2;
      } else if (fieldName === 'updatedAt') {
        //TODO: stop special casing this. It should check for __type === 'Date' and use .iso
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'string') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'boolean') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'Pointer') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.objectId);
        index += 2;
      } else if (fieldValue.__type === 'Date') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue instanceof Date) {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (fieldValue.__type === 'File') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, toPostgresValue(fieldValue));
        index += 2;
      } else if (fieldValue.__type === 'GeoPoint') {
        updatePatterns.push(`$${index}:name = POINT($${index + 1}, $${index + 2})`);
        values.push(fieldName, fieldValue.longitude, fieldValue.latitude);
        index += 3;
      } else if (fieldValue.__type === 'Polygon') {
        const value = convertPolygonToSQL(fieldValue.coordinates);
        updatePatterns.push(`$${index}:name = $${index + 1}::polygon`);
        values.push(fieldName, value);
        index += 2;
      } else if (fieldValue.__type === 'Relation') {
        // noop
      } else if (typeof fieldValue === 'number') {
        updatePatterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue);
        index += 2;
      } else if (typeof fieldValue === 'object' && schema.fields[fieldName] && schema.fields[fieldName].type === 'Object') {
        // Gather keys to increment
        const keysToIncrement = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set
          // Note that Object.keys is iterating over the **original** update object
          // and that some of the keys of the original update could be null or undefined:
          // (See the above check `if (fieldValue === null || typeof fieldValue == "undefined")`)
          const value = originalUpdate[k];
          return value && value.__op === 'Increment' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
        }).map(k => k.split('.')[1]);

        let incrementPatterns = '';
        if (keysToIncrement.length > 0) {
          incrementPatterns = ' || ' + keysToIncrement.map(c => {
            const amount = fieldValue[c].amount;
            return `CONCAT('{"${c}":', COALESCE($${index}:name->>'${c}','0')::int + ${amount}, '}')::jsonb`;
          }).join(' || ');
          // Strip the keys
          keysToIncrement.forEach(key => {
            delete fieldValue[key];
          });
        }

        const keysToDelete = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set.
          const value = originalUpdate[k];
          return value && value.__op === 'Delete' && k.split('.').length === 2 && k.split(".")[0] === fieldName;
        }).map(k => k.split('.')[1]);

        const deletePatterns = keysToDelete.reduce((p, c, i) => {
          return p + ` - '$${index + 1 + i}:value'`;
        }, '');

        updatePatterns.push(`$${index}:name = ('{}'::jsonb ${deletePatterns} ${incrementPatterns} || $${index + 1 + keysToDelete.length}::jsonb )`);

        values.push(fieldName, ...keysToDelete, JSON.stringify(fieldValue));
        index += 2 + keysToDelete.length;
      } else if (Array.isArray(fieldValue) && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        const expectedType = parseTypeToPostgresType(schema.fields[fieldName]);
        if (expectedType === 'text[]') {
          updatePatterns.push(`$${index}:name = $${index + 1}::text[]`);
        } else {
          let type = 'text';
          for (const elt of fieldValue) {
            if (typeof elt == 'object') {
              type = 'json';
              break;
            }
          }
          updatePatterns.push(`$${index}:name = array_to_json($${index + 1}::${type}[])::jsonb`);
        }
        values.push(fieldName, fieldValue);
        index += 2;
      } else {
        debug('Not supported update', fieldName, fieldValue);
        return Promise.reject(new _node2.default.Error(_node2.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support update ${JSON.stringify(fieldValue)} yet`));
      }
    }

    const where = buildWhereClause({ schema, index, query });
    values.push(...where.values);

    const whereClause = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `UPDATE $1:name SET ${updatePatterns.join()} ${whereClause} RETURNING *`;
    debug('update: ', qs, values);
    return this._client.any(qs, values);
  }

  // Hopefully, we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update) {
    debug('upsertOneObject', { className, query, update });
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue).catch(error => {
      // ignore duplicate value errors as it's upsert
      if (error.code !== _node2.default.Error.DUPLICATE_VALUE) {
        throw error;
      }
      return this.findOneAndUpdate(className, schema, query, update);
    });
  }

  find(className, schema, query, { skip, limit, sort, keys }) {
    debug('find', className, query, { skip, limit, sort, keys });
    const hasLimit = limit !== undefined;
    const hasSkip = skip !== undefined;
    let values = [className];
    const where = buildWhereClause({ schema, query, index: 2 });
    values.push(...where.values);

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const limitPattern = hasLimit ? `LIMIT $${values.length + 1}` : '';
    if (hasLimit) {
      values.push(limit);
    }
    const skipPattern = hasSkip ? `OFFSET $${values.length + 1}` : '';
    if (hasSkip) {
      values.push(skip);
    }

    let sortPattern = '';
    if (sort) {
      const sortCopy = sort;
      const sorting = Object.keys(sort).map(key => {
        const transformKey = transformDotFieldToComponents(key).join('->');
        // Using $idx pattern gives:  non-integer constant in ORDER BY
        if (sortCopy[key] === 1) {
          return `${transformKey} ASC`;
        }
        return `${transformKey} DESC`;
      }).join();
      sortPattern = sort !== undefined && Object.keys(sort).length > 0 ? `ORDER BY ${sorting}` : '';
    }
    if (where.sorts && Object.keys(where.sorts).length > 0) {
      sortPattern = `ORDER BY ${where.sorts.join()}`;
    }

    let columns = '*';
    if (keys) {
      // Exclude empty keys
      // Replace ACL by it's keys
      keys = keys.reduce((memo, key) => {
        if (key === 'ACL') {
          memo.push('_rperm');
          memo.push('_wperm');
        } else if (key.length > 0) {
          memo.push(key);
        }
        return memo;
      }, []);
      columns = keys.map((key, index) => {
        if (key === '$score') {
          return `ts_rank_cd(to_tsvector($${2}, $${3}:name), to_tsquery($${4}, $${5}), 32) as score`;
        }
        return `$${index + values.length + 1}:name`;
      }).join();
      values = values.concat(keys);
    }

    const qs = `SELECT ${columns} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern}`;
    debug(qs, values);
    return this._client.any(qs, values).catch(error => {
      // Query on non existing table, don't crash
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      return [];
    }).then(results => results.map(object => this.postgresObjectToParseObject(className, object, schema)));
  }

  // Converts from a postgres-format object to a REST-format object.
  // Does not strip out anything based on a lack of authentication.
  postgresObjectToParseObject(className, object, schema) {
    Object.keys(schema.fields).forEach(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer' && object[fieldName]) {
        object[fieldName] = { objectId: object[fieldName], __type: 'Pointer', className: schema.fields[fieldName].targetClass };
      }
      if (schema.fields[fieldName].type === 'Relation') {
        object[fieldName] = {
          __type: "Relation",
          className: schema.fields[fieldName].targetClass
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'GeoPoint') {
        object[fieldName] = {
          __type: "GeoPoint",
          latitude: object[fieldName].y,
          longitude: object[fieldName].x
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'Polygon') {
        let coords = object[fieldName];
        coords = coords.substr(2, coords.length - 4).split('),(');
        coords = coords.map(point => {
          return [parseFloat(point.split(',')[1]), parseFloat(point.split(',')[0])];
        });
        object[fieldName] = {
          __type: "Polygon",
          coordinates: coords
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'File') {
        object[fieldName] = {
          __type: 'File',
          name: object[fieldName]
        };
      }
    });
    //TODO: remove this reliance on the mongo format. DB adapter shouldn't know there is a difference between created at and any other date field.
    if (object.createdAt) {
      object.createdAt = object.createdAt.toISOString();
    }
    if (object.updatedAt) {
      object.updatedAt = object.updatedAt.toISOString();
    }
    if (object.expiresAt) {
      object.expiresAt = { __type: 'Date', iso: object.expiresAt.toISOString() };
    }
    if (object._email_verify_token_expires_at) {
      object._email_verify_token_expires_at = { __type: 'Date', iso: object._email_verify_token_expires_at.toISOString() };
    }
    if (object._account_lockout_expires_at) {
      object._account_lockout_expires_at = { __type: 'Date', iso: object._account_lockout_expires_at.toISOString() };
    }
    if (object._perishable_token_expires_at) {
      object._perishable_token_expires_at = { __type: 'Date', iso: object._perishable_token_expires_at.toISOString() };
    }
    if (object._password_changed_at) {
      object._password_changed_at = { __type: 'Date', iso: object._password_changed_at.toISOString() };
    }

    for (const fieldName in object) {
      if (object[fieldName] === null) {
        delete object[fieldName];
      }
      if (object[fieldName] instanceof Date) {
        object[fieldName] = { __type: 'Date', iso: object[fieldName].toISOString() };
      }
    }

    return object;
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  ensureUniqueness(className, schema, fieldNames) {
    // Use the same name for every ensureUniqueness attempt, because postgres
    // Will happily create the same index with multiple names.
    const constraintName = `unique_${fieldNames.sort().join('_')}`;
    const constraintPatterns = fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `ALTER TABLE $1:name ADD CONSTRAINT $2:name UNIQUE (${constraintPatterns.join()})`;
    return this._client.none(qs, [className, constraintName, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(constraintName)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(constraintName)) {
        // Cast the error into the proper parse error
        throw new _node2.default.Error(_node2.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  }

  // Executes a count.
  count(className, schema, query) {
    debug('count', className, query);
    const values = [className];
    const where = buildWhereClause({ schema, query, index: 2 });
    values.push(...where.values);

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `SELECT count(*) FROM $1:name ${wherePattern}`;
    return this._client.one(qs, values, a => +a.count).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      return 0;
    });
  }

  distinct(className, schema, query, fieldName) {
    debug('distinct', className, query);
    let field = fieldName;
    let column = fieldName;
    const isNested = fieldName.indexOf('.') >= 0;
    if (isNested) {
      field = transformDotFieldToComponents(fieldName).join('->');
      column = fieldName.split('.')[0];
    }
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const isPointerField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const values = [field, column, className];
    const where = buildWhereClause({ schema, query, index: 4 });
    values.push(...where.values);

    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const transformer = isArrayField ? 'jsonb_array_elements' : 'ON';
    let qs = `SELECT DISTINCT ${transformer}($1:name) $2:name FROM $3:name ${wherePattern}`;
    if (isNested) {
      qs = `SELECT DISTINCT ${transformer}($1:raw) $2:raw FROM $3:name ${wherePattern}`;
    }
    debug(qs, values);
    return this._client.any(qs, values).catch(error => {
      if (error.code === PostgresMissingColumnError) {
        return [];
      }
      throw error;
    }).then(results => {
      if (!isNested) {
        results = results.filter(object => object[field] !== null);
        return results.map(object => {
          if (!isPointerField) {
            return object[field];
          }
          return {
            __type: 'Pointer',
            className: schema.fields[fieldName].targetClass,
            objectId: object[field]
          };
        });
      }
      const child = fieldName.split('.')[1];
      return results.map(object => object[column][child]);
    }).then(results => results.map(object => this.postgresObjectToParseObject(className, object, schema)));
  }

  aggregate(className, schema, pipeline) {
    debug('aggregate', className, pipeline);
    const values = [className];
    let index = 2;
    let columns = [];
    let countField = null;
    let groupValues = null;
    let wherePattern = '';
    let limitPattern = '';
    let skipPattern = '';
    let sortPattern = '';
    let groupPattern = '';
    for (let i = 0; i < pipeline.length; i += 1) {
      const stage = pipeline[i];
      if (stage.$group) {
        for (const field in stage.$group) {
          const value = stage.$group[field];
          if (value === null || value === undefined) {
            continue;
          }
          if (field === '_id' && typeof value === 'string' && value !== '') {
            columns.push(`$${index}:name AS "objectId"`);
            groupPattern = `GROUP BY $${index}:name`;
            values.push(transformAggregateField(value));
            index += 1;
            continue;
          }
          if (field === '_id' && typeof value === 'object' && Object.keys(value).length !== 0) {
            groupValues = value;
            const groupByFields = [];
            for (const alias in value) {
              const operation = Object.keys(value[alias])[0];
              const source = transformAggregateField(value[alias][operation]);
              if (mongoAggregateToPostgres[operation]) {
                if (!groupByFields.includes(`"${source}"`)) {
                  groupByFields.push(`"${source}"`);
                }
                columns.push(`EXTRACT(${mongoAggregateToPostgres[operation]} FROM $${index}:name AT TIME ZONE 'UTC') AS $${index + 1}:name`);
                values.push(source, alias);
                index += 2;
              }
            }
            groupPattern = `GROUP BY $${index}:raw`;
            values.push(groupByFields.join());
            index += 1;
            continue;
          }
          if (value.$sum) {
            if (typeof value.$sum === 'string') {
              columns.push(`SUM($${index}:name) AS $${index + 1}:name`);
              values.push(transformAggregateField(value.$sum), field);
              index += 2;
            } else {
              countField = field;
              columns.push(`COUNT(*) AS $${index}:name`);
              values.push(field);
              index += 1;
            }
          }
          if (value.$max) {
            columns.push(`MAX($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$max), field);
            index += 2;
          }
          if (value.$min) {
            columns.push(`MIN($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$min), field);
            index += 2;
          }
          if (value.$avg) {
            columns.push(`AVG($${index}:name) AS $${index + 1}:name`);
            values.push(transformAggregateField(value.$avg), field);
            index += 2;
          }
        }
      } else {
        columns.push('*');
      }
      if (stage.$project) {
        if (columns.includes('*')) {
          columns = [];
        }
        for (const field in stage.$project) {
          const value = stage.$project[field];
          if (value === 1 || value === true) {
            columns.push(`$${index}:name`);
            values.push(field);
            index += 1;
          }
        }
      }
      if (stage.$match) {
        const patterns = [];
        const orOrAnd = stage.$match.hasOwnProperty('$or') ? ' OR ' : ' AND ';

        if (stage.$match.$or) {
          const collapse = {};
          stage.$match.$or.forEach(element => {
            for (const key in element) {
              collapse[key] = element[key];
            }
          });
          stage.$match = collapse;
        }
        for (const field in stage.$match) {
          const value = stage.$match[field];
          const matchPatterns = [];
          Object.keys(ParseToPosgresComparator).forEach(cmp => {
            if (value[cmp]) {
              const pgComparator = ParseToPosgresComparator[cmp];
              matchPatterns.push(`$${index}:name ${pgComparator} $${index + 1}`);
              values.push(field, toPostgresValue(value[cmp]));
              index += 2;
            }
          });
          if (matchPatterns.length > 0) {
            patterns.push(`(${matchPatterns.join(' AND ')})`);
          }
          if (schema.fields[field] && schema.fields[field].type && matchPatterns.length === 0) {
            patterns.push(`$${index}:name = $${index + 1}`);
            values.push(field, value);
            index += 2;
          }
        }
        wherePattern = patterns.length > 0 ? `WHERE ${patterns.join(` ${orOrAnd} `)}` : '';
      }
      if (stage.$limit) {
        limitPattern = `LIMIT $${index}`;
        values.push(stage.$limit);
        index += 1;
      }
      if (stage.$skip) {
        skipPattern = `OFFSET $${index}`;
        values.push(stage.$skip);
        index += 1;
      }
      if (stage.$sort) {
        const sort = stage.$sort;
        const keys = Object.keys(sort);
        const sorting = keys.map(key => {
          const transformer = sort[key] === 1 ? 'ASC' : 'DESC';
          const order = `$${index}:name ${transformer}`;
          index += 1;
          return order;
        }).join();
        values.push(...keys);
        sortPattern = sort !== undefined && sorting.length > 0 ? `ORDER BY ${sorting}` : '';
      }
    }

    const qs = `SELECT ${columns.join()} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern} ${groupPattern}`;
    debug(qs, values);
    return this._client.map(qs, values, a => this.postgresObjectToParseObject(className, a, schema)).then(results => {
      results.forEach(result => {
        if (!result.hasOwnProperty('objectId')) {
          result.objectId = null;
        }
        if (groupValues) {
          result.objectId = {};
          for (const key in groupValues) {
            result.objectId[key] = result[key];
            delete result[key];
          }
        }
        if (countField) {
          result[countField] = parseInt(result[countField], 10);
        }
      });
      return results;
    });
  }

  performInitialization({ VolatileClassesSchemas }) {
    // TODO: This method needs to be rewritten to make proper use of connections (@vitaly-t)
    debug('performInitialization');
    const promises = VolatileClassesSchemas.map(schema => {
      return this.createTable(schema.className, schema).catch(err => {
        if (err.code === PostgresDuplicateRelationError || err.code === _node2.default.Error.INVALID_CLASS_NAME) {
          return Promise.resolve();
        }
        throw err;
      }).then(() => this.schemaUpgrade(schema.className, schema));
    });
    return Promise.all(promises).then(() => {
      return this._client.tx('perform-initialization', t => {
        return t.batch([t.none(_sql2.default.misc.jsonObjectSetKeys), t.none(_sql2.default.array.add), t.none(_sql2.default.array.addUnique), t.none(_sql2.default.array.remove), t.none(_sql2.default.array.containsAll), t.none(_sql2.default.array.containsAllRegex), t.none(_sql2.default.array.contains)]);
      });
    }).then(data => {
      debug(`initializationDone in ${data.duration}`);
    }).catch(error => {
      /* eslint-disable no-console */
      console.error(error);
    });
  }

  createIndexes(className, indexes, conn) {
    return (conn || this._client).tx(t => t.batch(indexes.map(i => {
      return t.none('CREATE INDEX $1:name ON $2:name ($3:name)', [i.name, className, i.key]);
    })));
  }

  createIndexesIfNeeded(className, fieldName, type, conn) {
    return (conn || this._client).none('CREATE INDEX $1:name ON $2:name ($3:name)', [fieldName, className, type]);
  }

  dropIndexes(className, indexes, conn) {
    const queries = indexes.map(i => ({ query: 'DROP INDEX $1:name', values: i }));
    return (conn || this._client).tx(t => t.none(this._pgp.helpers.concat(queries)));
  }

  getIndexes(className) {
    const qs = 'SELECT * FROM pg_indexes WHERE tablename = ${className}';
    return this._client.any(qs, { className });
  }

  updateSchemaWithIndexes() {
    return Promise.resolve();
  }
}

exports.PostgresStorageAdapter = PostgresStorageAdapter;
function convertPolygonToSQL(polygon) {
  if (polygon.length < 3) {
    throw new _node2.default.Error(_node2.default.Error.INVALID_JSON, `Polygon must have at least 3 values`);
  }
  if (polygon[0][0] !== polygon[polygon.length - 1][0] || polygon[0][1] !== polygon[polygon.length - 1][1]) {
    polygon.push(polygon[0]);
  }
  const unique = polygon.filter((item, index, ar) => {
    let foundIndex = -1;
    for (let i = 0; i < ar.length; i += 1) {
      const pt = ar[i];
      if (pt[0] === item[0] && pt[1] === item[1]) {
        foundIndex = i;
        break;
      }
    }
    return foundIndex === index;
  });
  if (unique.length < 3) {
    throw new _node2.default.Error(_node2.default.Error.INTERNAL_SERVER_ERROR, 'GeoJSON: Loop must have at least 3 different vertices');
  }
  const points = polygon.map(point => {
    _node2.default.GeoPoint._validate(parseFloat(point[1]), parseFloat(point[0]));
    return `(${point[1]}, ${point[0]})`;
  }).join(', ');
  return `(${points})`;
}

function removeWhiteSpace(regex) {
  if (!regex.endsWith('\n')) {
    regex += '\n';
  }

  // remove non escaped comments
  return regex.replace(/([^\\])#.*\n/gmi, '$1')
  // remove lines starting with a comment
  .replace(/^#.*\n/gmi, '')
  // remove non escaped whitespace
  .replace(/([^\\])\s+/gmi, '$1')
  // remove whitespace at the beginning of a line
  .replace(/^\s+/, '').trim();
}

function processRegexPattern(s) {
  if (s && s.startsWith('^')) {
    // regex for startsWith
    return '^' + literalizeRegexPart(s.slice(1));
  } else if (s && s.endsWith('$')) {
    // regex for endsWith
    return literalizeRegexPart(s.slice(0, s.length - 1)) + '$';
  }

  // regex for contains
  return literalizeRegexPart(s);
}

function isStartsWithRegex(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('^')) {
    return false;
  }

  const matches = value.match(/\^\\Q.*\\E/);
  return !!matches;
}

function isAllValuesRegexOrNone(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }

  const firstValuesIsRegex = isStartsWithRegex(values[0].$regex);
  if (values.length === 1) {
    return firstValuesIsRegex;
  }

  for (let i = 1, length = values.length; i < length; ++i) {
    if (firstValuesIsRegex !== isStartsWithRegex(values[i].$regex)) {
      return false;
    }
  }

  return true;
}

function isAnyValueRegexStartsWith(values) {
  return values.some(function (value) {
    return isStartsWithRegex(value.$regex);
  });
}

function createLiteralRegex(remaining) {
  return remaining.split('').map(c => {
    if (c.match(/[0-9a-zA-Z]/) !== null) {
      // don't escape alphanumeric characters
      return c;
    }
    // escape everything else (single quotes with single quotes, everything else with a backslash)
    return c === `'` ? `''` : `\\${c}`;
  }).join('');
}

function literalizeRegexPart(s) {
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);
  if (result1 && result1.length > 1 && result1.index > -1) {
    // process regex that has a beginning and an end specified for the literal text
    const prefix = s.substr(0, result1.index);
    const remaining = result1[1];

    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // process regex that has a beginning specified for the literal text
  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);
  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substr(0, result2.index);
    const remaining = result2[1];

    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // remove all instances of \Q and \E from the remaining text & escape single quotes
  return s.replace(/([^\\])(\\E)/, '$1').replace(/([^\\])(\\Q)/, '$1').replace(/^\\E/, '').replace(/^\\Q/, '').replace(/([^'])'/, `$1''`).replace(/^'([^'])/, `''$1`);
}

var GeoPointCoder = {
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'GeoPoint';
  }
};

exports.default = PostgresStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXIuanMiXSwibmFtZXMiOlsiUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvciIsIlBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yIiwiUG9zdGdyZXNEdXBsaWNhdGVPYmplY3RFcnJvciIsIlBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciIsIlBvc3RncmVzVHJhbnNhY3Rpb25BYm9ydGVkRXJyb3IiLCJsb2dnZXIiLCJyZXF1aXJlIiwiZGVidWciLCJhcmdzIiwiYXJndW1lbnRzIiwiY29uY2F0Iiwic2xpY2UiLCJsZW5ndGgiLCJsb2ciLCJnZXRMb2dnZXIiLCJhcHBseSIsInBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlIiwidHlwZSIsImNvbnRlbnRzIiwiSlNPTiIsInN0cmluZ2lmeSIsIlBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvciIsIm1vbmdvQWdncmVnYXRlVG9Qb3N0Z3JlcyIsIiRkYXlPZk1vbnRoIiwiJGRheU9mV2VlayIsIiRkYXlPZlllYXIiLCIkaXNvRGF5T2ZXZWVrIiwiJGlzb1dlZWtZZWFyIiwiJGhvdXIiLCIkbWludXRlIiwiJHNlY29uZCIsIiRtaWxsaXNlY29uZCIsIiRtb250aCIsIiR3ZWVrIiwiJHllYXIiLCJ0b1Bvc3RncmVzVmFsdWUiLCJ2YWx1ZSIsIl9fdHlwZSIsImlzbyIsIm5hbWUiLCJ0cmFuc2Zvcm1WYWx1ZSIsIm9iamVjdElkIiwiZW1wdHlDTFBTIiwiT2JqZWN0IiwiZnJlZXplIiwiZmluZCIsImdldCIsImNyZWF0ZSIsInVwZGF0ZSIsImRlbGV0ZSIsImFkZEZpZWxkIiwiZGVmYXVsdENMUFMiLCJ0b1BhcnNlU2NoZW1hIiwic2NoZW1hIiwiY2xhc3NOYW1lIiwiZmllbGRzIiwiX2hhc2hlZF9wYXNzd29yZCIsIl93cGVybSIsIl9ycGVybSIsImNscHMiLCJjbGFzc0xldmVsUGVybWlzc2lvbnMiLCJpbmRleGVzIiwidG9Qb3N0Z3Jlc1NjaGVtYSIsIl9wYXNzd29yZF9oaXN0b3J5IiwiaGFuZGxlRG90RmllbGRzIiwib2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJmaWVsZE5hbWUiLCJpbmRleE9mIiwiY29tcG9uZW50cyIsInNwbGl0IiwiZmlyc3QiLCJzaGlmdCIsImN1cnJlbnRPYmoiLCJuZXh0IiwiX19vcCIsInVuZGVmaW5lZCIsInRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzIiwibWFwIiwiY21wdCIsImluZGV4IiwidHJhbnNmb3JtRG90RmllbGQiLCJqb2luIiwidHJhbnNmb3JtQWdncmVnYXRlRmllbGQiLCJzdWJzdHIiLCJ2YWxpZGF0ZUtleXMiLCJrZXkiLCJpbmNsdWRlcyIsIlBhcnNlIiwiRXJyb3IiLCJJTlZBTElEX05FU1RFRF9LRVkiLCJqb2luVGFibGVzRm9yU2NoZW1hIiwibGlzdCIsImZpZWxkIiwicHVzaCIsImJ1aWxkV2hlcmVDbGF1c2UiLCJxdWVyeSIsInBhdHRlcm5zIiwidmFsdWVzIiwic29ydHMiLCJpc0FycmF5RmllbGQiLCJpbml0aWFsUGF0dGVybnNMZW5ndGgiLCJmaWVsZFZhbHVlIiwiJGV4aXN0cyIsIiRpbiIsImluUGF0dGVybnMiLCJsaXN0RWxlbSIsIiRyZWdleCIsIk1BWF9JTlRfUExVU19PTkUiLCJjbGF1c2VzIiwiY2xhdXNlVmFsdWVzIiwic3ViUXVlcnkiLCJjbGF1c2UiLCJwYXR0ZXJuIiwib3JPckFuZCIsIm5vdCIsIiRuZSIsIiRlcSIsImlzSW5Pck5pbiIsIkFycmF5IiwiaXNBcnJheSIsIiRuaW4iLCJhbGxvd051bGwiLCJsaXN0SW5kZXgiLCJjcmVhdGVDb25zdHJhaW50IiwiYmFzZUFycmF5Iiwibm90SW4iLCJfIiwiZmxhdE1hcCIsImVsdCIsIklOVkFMSURfSlNPTiIsIiRhbGwiLCJpc0FueVZhbHVlUmVnZXhTdGFydHNXaXRoIiwiaXNBbGxWYWx1ZXNSZWdleE9yTm9uZSIsImkiLCJwcm9jZXNzUmVnZXhQYXR0ZXJuIiwic3Vic3RyaW5nIiwiJGNvbnRhaW5lZEJ5IiwiYXJyIiwiJHRleHQiLCJzZWFyY2giLCIkc2VhcmNoIiwibGFuZ3VhZ2UiLCIkdGVybSIsIiRsYW5ndWFnZSIsIiRjYXNlU2Vuc2l0aXZlIiwiJGRpYWNyaXRpY1NlbnNpdGl2ZSIsIiRuZWFyU3BoZXJlIiwicG9pbnQiLCJkaXN0YW5jZSIsIiRtYXhEaXN0YW5jZSIsImRpc3RhbmNlSW5LTSIsImxvbmdpdHVkZSIsImxhdGl0dWRlIiwiJHdpdGhpbiIsIiRib3giLCJib3giLCJsZWZ0IiwiYm90dG9tIiwicmlnaHQiLCJ0b3AiLCIkZ2VvV2l0aGluIiwiJGNlbnRlclNwaGVyZSIsImNlbnRlclNwaGVyZSIsIkdlb1BvaW50IiwiR2VvUG9pbnRDb2RlciIsImlzVmFsaWRKU09OIiwiX3ZhbGlkYXRlIiwiaXNOYU4iLCIkcG9seWdvbiIsInBvbHlnb24iLCJwb2ludHMiLCJjb29yZGluYXRlcyIsIiRnZW9JbnRlcnNlY3RzIiwiJHBvaW50IiwicmVnZXgiLCJvcGVyYXRvciIsIm9wdHMiLCIkb3B0aW9ucyIsInJlbW92ZVdoaXRlU3BhY2UiLCJjb252ZXJ0UG9seWdvblRvU1FMIiwiY21wIiwicGdDb21wYXJhdG9yIiwiT1BFUkFUSU9OX0ZPUkJJRERFTiIsIlBvc3RncmVzU3RvcmFnZUFkYXB0ZXIiLCJjb25zdHJ1Y3RvciIsInVyaSIsImNvbGxlY3Rpb25QcmVmaXgiLCJkYXRhYmFzZU9wdGlvbnMiLCJfY29sbGVjdGlvblByZWZpeCIsImNsaWVudCIsInBncCIsIl9jbGllbnQiLCJfcGdwIiwiY2FuU29ydE9uSm9pblRhYmxlcyIsImhhbmRsZVNodXRkb3duIiwiJHBvb2wiLCJlbmQiLCJfZW5zdXJlU2NoZW1hQ29sbGVjdGlvbkV4aXN0cyIsImNvbm4iLCJub25lIiwiY2F0Y2giLCJlcnJvciIsImNvZGUiLCJjbGFzc0V4aXN0cyIsIm9uZSIsImEiLCJleGlzdHMiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwic2VsZiIsInRhc2siLCJ0Iiwic2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQiLCJzdWJtaXR0ZWRJbmRleGVzIiwiZXhpc3RpbmdJbmRleGVzIiwiUHJvbWlzZSIsInJlc29sdmUiLCJfaWRfIiwiX2lkIiwiZGVsZXRlZEluZGV4ZXMiLCJpbnNlcnRlZEluZGV4ZXMiLCJJTlZBTElEX1FVRVJZIiwiaGFzT3duUHJvcGVydHkiLCJ0eCIsImNyZWF0ZUluZGV4ZXMiLCJkcm9wSW5kZXhlcyIsImNyZWF0ZUNsYXNzIiwicTEiLCJjcmVhdGVUYWJsZSIsInEyIiwicTMiLCJiYXRjaCIsInRoZW4iLCJlcnIiLCJkYXRhIiwicmVzdWx0IiwiZGV0YWlsIiwiRFVQTElDQVRFX1ZBTFVFIiwidmFsdWVzQXJyYXkiLCJwYXR0ZXJuc0FycmF5IiwiYXNzaWduIiwiX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0IiwiX2VtYWlsX3ZlcmlmeV90b2tlbiIsIl9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCIsIl9mYWlsZWRfbG9naW5fY291bnQiLCJfcGVyaXNoYWJsZV90b2tlbiIsIl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQiLCJfcGFzc3dvcmRfY2hhbmdlZF9hdCIsInJlbGF0aW9ucyIsInBhcnNlVHlwZSIsInFzIiwiam9pblRhYmxlIiwic2NoZW1hVXBncmFkZSIsImNvbHVtbnMiLCJjb2x1bW5fbmFtZSIsIm5ld0NvbHVtbnMiLCJmaWx0ZXIiLCJpdGVtIiwiYWRkRmllbGRJZk5vdEV4aXN0cyIsInBvc3RncmVzVHlwZSIsImFueSIsInBhdGgiLCJkZWxldGVDbGFzcyIsIm9wZXJhdGlvbnMiLCJoZWxwZXJzIiwiZGVsZXRlQWxsQ2xhc3NlcyIsIm5vdyIsIkRhdGUiLCJnZXRUaW1lIiwicmVzdWx0cyIsImpvaW5zIiwicmVkdWNlIiwiY2xhc3NlcyIsInF1ZXJpZXMiLCJkZWxldGVGaWVsZHMiLCJmaWVsZE5hbWVzIiwiaWR4IiwiZ2V0QWxsQ2xhc3NlcyIsInJvdyIsImdldENsYXNzIiwiY3JlYXRlT2JqZWN0IiwiY29sdW1uc0FycmF5IiwiZ2VvUG9pbnRzIiwiYXV0aERhdGFNYXRjaCIsIm1hdGNoIiwicHJvdmlkZXIiLCJwb3AiLCJpbml0aWFsVmFsdWVzIiwidmFsIiwidGVybWluYXRpb24iLCJnZW9Qb2ludHNJbmplY3RzIiwibCIsImNvbHVtbnNQYXR0ZXJuIiwiY29sIiwidmFsdWVzUGF0dGVybiIsIm9wcyIsInVuZGVybHlpbmdFcnJvciIsImNvbnN0cmFpbnQiLCJtYXRjaGVzIiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwiZGVsZXRlT2JqZWN0c0J5UXVlcnkiLCJ3aGVyZSIsImNvdW50IiwiT0JKRUNUX05PVF9GT1VORCIsImZpbmRPbmVBbmRVcGRhdGUiLCJ1cGRhdGVPYmplY3RzQnlRdWVyeSIsInVwZGF0ZVBhdHRlcm5zIiwib3JpZ2luYWxVcGRhdGUiLCJnZW5lcmF0ZSIsImpzb25iIiwibGFzdEtleSIsImZpZWxkTmFtZUluZGV4Iiwic3RyIiwiYW1vdW50Iiwib2JqZWN0cyIsImtleXNUb0luY3JlbWVudCIsImsiLCJpbmNyZW1lbnRQYXR0ZXJucyIsImMiLCJrZXlzVG9EZWxldGUiLCJkZWxldGVQYXR0ZXJucyIsInAiLCJleHBlY3RlZFR5cGUiLCJyZWplY3QiLCJ3aGVyZUNsYXVzZSIsInVwc2VydE9uZU9iamVjdCIsImNyZWF0ZVZhbHVlIiwic2tpcCIsImxpbWl0Iiwic29ydCIsImhhc0xpbWl0IiwiaGFzU2tpcCIsIndoZXJlUGF0dGVybiIsImxpbWl0UGF0dGVybiIsInNraXBQYXR0ZXJuIiwic29ydFBhdHRlcm4iLCJzb3J0Q29weSIsInNvcnRpbmciLCJ0cmFuc2Zvcm1LZXkiLCJtZW1vIiwicG9zdGdyZXNPYmplY3RUb1BhcnNlT2JqZWN0IiwidGFyZ2V0Q2xhc3MiLCJ5IiwieCIsImNvb3JkcyIsInBhcnNlRmxvYXQiLCJjcmVhdGVkQXQiLCJ0b0lTT1N0cmluZyIsInVwZGF0ZWRBdCIsImV4cGlyZXNBdCIsImVuc3VyZVVuaXF1ZW5lc3MiLCJjb25zdHJhaW50TmFtZSIsImNvbnN0cmFpbnRQYXR0ZXJucyIsIm1lc3NhZ2UiLCJkaXN0aW5jdCIsImNvbHVtbiIsImlzTmVzdGVkIiwiaXNQb2ludGVyRmllbGQiLCJ0cmFuc2Zvcm1lciIsImNoaWxkIiwiYWdncmVnYXRlIiwicGlwZWxpbmUiLCJjb3VudEZpZWxkIiwiZ3JvdXBWYWx1ZXMiLCJncm91cFBhdHRlcm4iLCJzdGFnZSIsIiRncm91cCIsImdyb3VwQnlGaWVsZHMiLCJhbGlhcyIsIm9wZXJhdGlvbiIsInNvdXJjZSIsIiRzdW0iLCIkbWF4IiwiJG1pbiIsIiRhdmciLCIkcHJvamVjdCIsIiRtYXRjaCIsIiRvciIsImNvbGxhcHNlIiwiZWxlbWVudCIsIm1hdGNoUGF0dGVybnMiLCIkbGltaXQiLCIkc2tpcCIsIiRzb3J0Iiwib3JkZXIiLCJwYXJzZUludCIsInBlcmZvcm1Jbml0aWFsaXphdGlvbiIsIlZvbGF0aWxlQ2xhc3Nlc1NjaGVtYXMiLCJwcm9taXNlcyIsIklOVkFMSURfQ0xBU1NfTkFNRSIsImFsbCIsInNxbCIsIm1pc2MiLCJqc29uT2JqZWN0U2V0S2V5cyIsImFycmF5IiwiYWRkIiwiYWRkVW5pcXVlIiwicmVtb3ZlIiwiY29udGFpbnNBbGwiLCJjb250YWluc0FsbFJlZ2V4IiwiY29udGFpbnMiLCJkdXJhdGlvbiIsImNvbnNvbGUiLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJnZXRJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJ1bmlxdWUiLCJhciIsImZvdW5kSW5kZXgiLCJwdCIsIklOVEVSTkFMX1NFUlZFUl9FUlJPUiIsImVuZHNXaXRoIiwicmVwbGFjZSIsInRyaW0iLCJzIiwic3RhcnRzV2l0aCIsImxpdGVyYWxpemVSZWdleFBhcnQiLCJpc1N0YXJ0c1dpdGhSZWdleCIsImZpcnN0VmFsdWVzSXNSZWdleCIsInNvbWUiLCJjcmVhdGVMaXRlcmFsUmVnZXgiLCJyZW1haW5pbmciLCJtYXRjaGVyMSIsInJlc3VsdDEiLCJwcmVmaXgiLCJtYXRjaGVyMiIsInJlc3VsdDIiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBRUE7O0FBRUE7OztBQUhBOztBQUVBOzs7O0FBRUE7Ozs7QUFDQTs7OztBQWlCQTs7OztBQWZBLE1BQU1BLG9DQUFvQyxPQUExQztBQUNBLE1BQU1DLGlDQUFpQyxPQUF2QztBQUNBLE1BQU1DLCtCQUErQixPQUFyQztBQUNBLE1BQU1DLDZCQUE2QixPQUFuQztBQUNBLE1BQU1DLCtCQUErQixPQUFyQztBQUNBLE1BQU1DLG9DQUFvQyxPQUExQztBQUNBLE1BQU1DLGtDQUFrQyxPQUF4QztBQUNBLE1BQU1DLFNBQVNDLFFBQVEsaUJBQVIsQ0FBZjs7QUFFQSxNQUFNQyxRQUFRLFVBQVMsR0FBR0MsSUFBWixFQUF1QjtBQUNuQ0EsU0FBTyxDQUFDLFNBQVNDLFVBQVUsQ0FBVixDQUFWLEVBQXdCQyxNQUF4QixDQUErQkYsS0FBS0csS0FBTCxDQUFXLENBQVgsRUFBY0gsS0FBS0ksTUFBbkIsQ0FBL0IsQ0FBUDtBQUNBLFFBQU1DLE1BQU1SLE9BQU9TLFNBQVAsRUFBWjtBQUNBRCxNQUFJTixLQUFKLENBQVVRLEtBQVYsQ0FBZ0JGLEdBQWhCLEVBQXFCTCxJQUFyQjtBQUNELENBSkQ7O0FBV0EsTUFBTVEsMEJBQTBCQyxRQUFRO0FBQ3RDLFVBQVFBLEtBQUtBLElBQWI7QUFDQSxTQUFLLFFBQUw7QUFBZSxhQUFPLE1BQVA7QUFDZixTQUFLLE1BQUw7QUFBYSxhQUFPLDBCQUFQO0FBQ2IsU0FBSyxRQUFMO0FBQWUsYUFBTyxPQUFQO0FBQ2YsU0FBSyxNQUFMO0FBQWEsYUFBTyxNQUFQO0FBQ2IsU0FBSyxTQUFMO0FBQWdCLGFBQU8sU0FBUDtBQUNoQixTQUFLLFNBQUw7QUFBZ0IsYUFBTyxVQUFQO0FBQ2hCLFNBQUssUUFBTDtBQUFlLGFBQU8sa0JBQVA7QUFDZixTQUFLLFVBQUw7QUFBaUIsYUFBTyxPQUFQO0FBQ2pCLFNB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LE9BQUYsQ0FBVSxjQUFWLEVBQTBCLElBQTFCLEVBQ0dBLE9BREgsQ0FDVyxjQURYLEVBQzJCLElBRDNCLEVBRUdBLE9BRkgsQ0FFVyxNQUZYLEVBRW1CLEVBRm5CLEVBR0dBLE9BSEgsQ0FHVyxNQUhYLEVBR21CLEVBSG5CLEVBSUdBLE9BSkgsQ0FJVyxTQUpYLEVBSXVCLE1BSnZCLEVBS0dBLE9BTEgsQ0FLVyxVQUxYLEVBS3dCLE1BTHhCLENBREY7QUFRRDs7QUFFRCxJQUFJelAsZ0JBQWdCO0FBQ2xCQyxjQUFZbkksS0FBWixFQUFtQjtBQUNqQixXQUFRLE9BQU9BLEtBQVAsS0FBaUIsUUFBakIsSUFDTkEsVUFBVSxJQURKLElBRU5BLE1BQU1DLE1BQU4sS0FBaUIsVUFGbkI7QUFJRDtBQU5pQixDQUFwQjs7a0JBU2VvSixzQiIsImZpbGUiOiJQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyLmpzIiwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCB9IGZyb20gJy4vUG9zdGdyZXNDbGllbnQnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgICAgICAgICAgICBmcm9tICdwYXJzZS9ub2RlJztcbi8vIEBmbG93LWRpc2FibGUtbmV4dFxuaW1wb3J0IF8gICAgICAgICAgICAgICAgZnJvbSAnbG9kYXNoJztcbmltcG9ydCBzcWwgICAgICAgICAgICAgIGZyb20gJy4vc3FsJztcblxuY29uc3QgUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yID0gJzQyUDAxJztcbmNvbnN0IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciA9ICc0MlAwNyc7XG5jb25zdCBQb3N0Z3Jlc0R1cGxpY2F0ZUNvbHVtbkVycm9yID0gJzQyNzAxJztcbmNvbnN0IFBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yID0gJzQyNzAzJztcbmNvbnN0IFBvc3RncmVzRHVwbGljYXRlT2JqZWN0RXJyb3IgPSAnNDI3MTAnO1xuY29uc3QgUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yID0gJzIzNTA1JztcbmNvbnN0IFBvc3RncmVzVHJhbnNhY3Rpb25BYm9ydGVkRXJyb3IgPSAnMjVQMDInO1xuY29uc3QgbG9nZ2VyID0gcmVxdWlyZSgnLi4vLi4vLi4vbG9nZ2VyJyk7XG5cbmNvbnN0IGRlYnVnID0gZnVuY3Rpb24oLi4uYXJnczogYW55KSB7XG4gIGFyZ3MgPSBbJ1BHOiAnICsgYXJndW1lbnRzWzBdXS5jb25jYXQoYXJncy5zbGljZSgxLCBhcmdzLmxlbmd0aCkpO1xuICBjb25zdCBsb2cgPSBsb2dnZXIuZ2V0TG9nZ2VyKCk7XG4gIGxvZy5kZWJ1Zy5hcHBseShsb2csIGFyZ3MpO1xufVxuXG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9ICAgIGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCB0eXBlIHsgU2NoZW1hVHlwZSxcbiAgUXVlcnlUeXBlLFxuICBRdWVyeU9wdGlvbnMgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5cbmNvbnN0IHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlID0gdHlwZSA9PiB7XG4gIHN3aXRjaCAodHlwZS50eXBlKSB7XG4gIGNhc2UgJ1N0cmluZyc6IHJldHVybiAndGV4dCc7XG4gIGNhc2UgJ0RhdGUnOiByZXR1cm4gJ3RpbWVzdGFtcCB3aXRoIHRpbWUgem9uZSc7XG4gIGNhc2UgJ09iamVjdCc6IHJldHVybiAnanNvbmInO1xuICBjYXNlICdGaWxlJzogcmV0dXJuICd0ZXh0JztcbiAgY2FzZSAnQm9vbGVhbic6IHJldHVybiAnYm9vbGVhbic7XG4gIGNhc2UgJ1BvaW50ZXInOiByZXR1cm4gJ2NoYXIoMTApJztcbiAgY2FzZSAnTnVtYmVyJzogcmV0dXJuICdkb3VibGUgcHJlY2lzaW9uJztcbiAgY2FzZSAnR2VvUG9pbnQnOiByZXR1cm4gJ3BvaW50JztcbiAgY2FzZSAnQnl0ZXMnOiByZXR1cm4gJ2pzb25iJztcbiAgY2FzZSAnUG9seWdvbic6IHJldHVybiAncG9seWdvbic7XG4gIGNhc2UgJ0FycmF5JzpcbiAgICBpZiAodHlwZS5jb250ZW50cyAmJiB0eXBlLmNvbnRlbnRzLnR5cGUgPT09ICdTdHJpbmcnKSB7XG4gICAgICByZXR1cm4gJ3RleHRbXSc7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiAnanNvbmInO1xuICAgIH1cbiAgZGVmYXVsdDogdGhyb3cgYG5vIHR5cGUgZm9yICR7SlNPTi5zdHJpbmdpZnkodHlwZSl9IHlldGA7XG4gIH1cbn07XG5cbmNvbnN0IFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvciA9IHtcbiAgJyRndCc6ICc+JyxcbiAgJyRsdCc6ICc8JyxcbiAgJyRndGUnOiAnPj0nLFxuICAnJGx0ZSc6ICc8PSdcbn1cblxuY29uc3QgbW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzID0ge1xuICAkZGF5T2ZNb250aDogJ0RBWScsXG4gICRkYXlPZldlZWs6ICdET1cnLFxuICAkZGF5T2ZZZWFyOiAnRE9ZJyxcbiAgJGlzb0RheU9mV2VlazogJ0lTT0RPVycsXG4gICRpc29XZWVrWWVhcjonSVNPWUVBUicsXG4gICRob3VyOiAnSE9VUicsXG4gICRtaW51dGU6ICdNSU5VVEUnLFxuICAkc2Vjb25kOiAnU0VDT05EJyxcbiAgJG1pbGxpc2Vjb25kOiAnTUlMTElTRUNPTkRTJyxcbiAgJG1vbnRoOiAnTU9OVEgnLFxuICAkd2VlazogJ1dFRUsnLFxuICAkeWVhcjogJ1lFQVInLFxufTtcblxuY29uc3QgdG9Qb3N0Z3Jlc1ZhbHVlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgIGlmICh2YWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcmV0dXJuIHZhbHVlLmlzbztcbiAgICB9XG4gICAgaWYgKHZhbHVlLl9fdHlwZSA9PT0gJ0ZpbGUnKSB7XG4gICAgICByZXR1cm4gdmFsdWUubmFtZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG5jb25zdCB0cmFuc2Zvcm1WYWx1ZSA9IHZhbHVlID0+IHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgdmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICByZXR1cm4gdmFsdWUub2JqZWN0SWQ7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vLyBEdXBsaWNhdGUgZnJvbSB0aGVuIG1vbmdvIGFkYXB0ZXIuLi5cbmNvbnN0IGVtcHR5Q0xQUyA9IE9iamVjdC5mcmVlemUoe1xuICBmaW5kOiB7fSxcbiAgZ2V0OiB7fSxcbiAgY3JlYXRlOiB7fSxcbiAgdXBkYXRlOiB7fSxcbiAgZGVsZXRlOiB7fSxcbiAgYWRkRmllbGQ6IHt9LFxufSk7XG5cbmNvbnN0IGRlZmF1bHRDTFBTID0gT2JqZWN0LmZyZWV6ZSh7XG4gIGZpbmQ6IHsnKic6IHRydWV9LFxuICBnZXQ6IHsnKic6IHRydWV9LFxuICBjcmVhdGU6IHsnKic6IHRydWV9LFxuICB1cGRhdGU6IHsnKic6IHRydWV9LFxuICBkZWxldGU6IHsnKic6IHRydWV9LFxuICBhZGRGaWVsZDogeycqJzogdHJ1ZX0sXG59KTtcblxuY29uc3QgdG9QYXJzZVNjaGVtYSA9IChzY2hlbWEpID0+IHtcbiAgaWYgKHNjaGVtYS5jbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkO1xuICB9XG4gIGlmIChzY2hlbWEuZmllbGRzKSB7XG4gICAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX3dwZXJtO1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl9ycGVybTtcbiAgfVxuICBsZXQgY2xwcyA9IGRlZmF1bHRDTFBTO1xuICBpZiAoc2NoZW1hLmNsYXNzTGV2ZWxQZXJtaXNzaW9ucykge1xuICAgIGNscHMgPSB7Li4uZW1wdHlDTFBTLCAuLi5zY2hlbWEuY2xhc3NMZXZlbFBlcm1pc3Npb25zfTtcbiAgfVxuICBsZXQgaW5kZXhlcyA9IHt9O1xuICBpZiAoc2NoZW1hLmluZGV4ZXMpIHtcbiAgICBpbmRleGVzID0gey4uLnNjaGVtYS5pbmRleGVzfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGNsYXNzTmFtZTogc2NoZW1hLmNsYXNzTmFtZSxcbiAgICBmaWVsZHM6IHNjaGVtYS5maWVsZHMsXG4gICAgY2xhc3NMZXZlbFBlcm1pc3Npb25zOiBjbHBzLFxuICAgIGluZGV4ZXMsXG4gIH07XG59XG5cbmNvbnN0IHRvUG9zdGdyZXNTY2hlbWEgPSAoc2NoZW1hKSA9PiB7XG4gIGlmICghc2NoZW1hKSB7XG4gICAgcmV0dXJuIHNjaGVtYTtcbiAgfVxuICBzY2hlbWEuZmllbGRzID0gc2NoZW1hLmZpZWxkcyB8fCB7fTtcbiAgc2NoZW1hLmZpZWxkcy5fd3Blcm0gPSB7dHlwZTogJ0FycmF5JywgY29udGVudHM6IHt0eXBlOiAnU3RyaW5nJ319XG4gIHNjaGVtYS5maWVsZHMuX3JwZXJtID0ge3R5cGU6ICdBcnJheScsIGNvbnRlbnRzOiB7dHlwZTogJ1N0cmluZyd9fVxuICBpZiAoc2NoZW1hLmNsYXNzTmFtZSA9PT0gJ19Vc2VyJykge1xuICAgIHNjaGVtYS5maWVsZHMuX2hhc2hlZF9wYXNzd29yZCA9IHt0eXBlOiAnU3RyaW5nJ307XG4gICAgc2NoZW1hLmZpZWxkcy5fcGFzc3dvcmRfaGlzdG9yeSA9IHt0eXBlOiAnQXJyYXknfTtcbiAgfVxuICByZXR1cm4gc2NoZW1hO1xufVxuXG5jb25zdCBoYW5kbGVEb3RGaWVsZHMgPSAob2JqZWN0KSA9PiB7XG4gIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgIGNvbnN0IGNvbXBvbmVudHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IGZpcnN0ID0gY29tcG9uZW50cy5zaGlmdCgpO1xuICAgICAgb2JqZWN0W2ZpcnN0XSA9IG9iamVjdFtmaXJzdF0gfHwge307XG4gICAgICBsZXQgY3VycmVudE9iaiA9IG9iamVjdFtmaXJzdF07XG4gICAgICBsZXQgbmV4dDtcbiAgICAgIGxldCB2YWx1ZSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgaWYgKHZhbHVlICYmIHZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHZhbHVlID0gdW5kZWZpbmVkO1xuICAgICAgfVxuICAgICAgLyogZXNsaW50LWRpc2FibGUgbm8tY29uZC1hc3NpZ24gKi9cbiAgICAgIHdoaWxlKG5leHQgPSBjb21wb25lbnRzLnNoaWZ0KCkpIHtcbiAgICAgIC8qIGVzbGludC1lbmFibGUgbm8tY29uZC1hc3NpZ24gKi9cbiAgICAgICAgY3VycmVudE9ialtuZXh0XSA9IGN1cnJlbnRPYmpbbmV4dF0gfHwge307XG4gICAgICAgIGlmIChjb21wb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIGN1cnJlbnRPYmpbbmV4dF0gPSB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBjdXJyZW50T2JqID0gY3VycmVudE9ialtuZXh0XTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBvYmplY3RbZmllbGROYW1lXTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb2JqZWN0O1xufVxuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyA9IChmaWVsZE5hbWUpID0+IHtcbiAgcmV0dXJuIGZpZWxkTmFtZS5zcGxpdCgnLicpLm1hcCgoY21wdCwgaW5kZXgpID0+IHtcbiAgICBpZiAoaW5kZXggPT09IDApIHtcbiAgICAgIHJldHVybiBgXCIke2NtcHR9XCJgO1xuICAgIH1cbiAgICByZXR1cm4gYCcke2NtcHR9J2A7XG4gIH0pO1xufVxuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZCA9IChmaWVsZE5hbWUpID0+IHtcbiAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xKSB7XG4gICAgcmV0dXJuIGBcIiR7ZmllbGROYW1lfVwiYDtcbiAgfVxuICBjb25zdCBjb21wb25lbnRzID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKTtcbiAgbGV0IG5hbWUgPSBjb21wb25lbnRzLnNsaWNlKDAsIGNvbXBvbmVudHMubGVuZ3RoIC0gMSkuam9pbignLT4nKTtcbiAgbmFtZSArPSAnLT4+JyArIGNvbXBvbmVudHNbY29tcG9uZW50cy5sZW5ndGggLSAxXTtcbiAgcmV0dXJuIG5hbWU7XG59XG5cbmNvbnN0IHRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkID0gKGZpZWxkTmFtZSkgPT4ge1xuICBpZiAodHlwZW9mIGZpZWxkTmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gZmllbGROYW1lO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX2NyZWF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICdjcmVhdGVkQXQnO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX3VwZGF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICd1cGRhdGVkQXQnO1xuICB9XG4gIHJldHVybiBmaWVsZE5hbWUuc3Vic3RyKDEpO1xufVxuXG5jb25zdCB2YWxpZGF0ZUtleXMgPSAob2JqZWN0KSA9PiB7XG4gIGlmICh0eXBlb2Ygb2JqZWN0ID09ICdvYmplY3QnKSB7XG4gICAgZm9yIChjb25zdCBrZXkgaW4gb2JqZWN0KSB7XG4gICAgICBpZiAodHlwZW9mIG9iamVjdFtrZXldID09ICdvYmplY3QnKSB7XG4gICAgICAgIHZhbGlkYXRlS2V5cyhvYmplY3Rba2V5XSk7XG4gICAgICB9XG5cbiAgICAgIGlmKGtleS5pbmNsdWRlcygnJCcpIHx8IGtleS5pbmNsdWRlcygnLicpKXtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfTkVTVEVEX0tFWSwgXCJOZXN0ZWQga2V5cyBzaG91bGQgbm90IGNvbnRhaW4gdGhlICckJyBvciAnLicgY2hhcmFjdGVyc1wiKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cblxuLy8gUmV0dXJucyB0aGUgbGlzdCBvZiBqb2luIHRhYmxlcyBvbiBhIHNjaGVtYVxuY29uc3Qgam9pblRhYmxlc0ZvclNjaGVtYSA9IChzY2hlbWEpID0+IHtcbiAgY29uc3QgbGlzdCA9IFtdO1xuICBpZiAoc2NoZW1hKSB7XG4gICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoZmllbGQpID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkXS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIGxpc3QucHVzaChgX0pvaW46JHtmaWVsZH06JHtzY2hlbWEuY2xhc3NOYW1lfWApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG4gIHJldHVybiBsaXN0O1xufVxuXG5pbnRlcmZhY2UgV2hlcmVDbGF1c2Uge1xuICBwYXR0ZXJuOiBzdHJpbmc7XG4gIHZhbHVlczogQXJyYXk8YW55PjtcbiAgc29ydHM6IEFycmF5PGFueT47XG59XG5cbmNvbnN0IGJ1aWxkV2hlcmVDbGF1c2UgPSAoeyBzY2hlbWEsIHF1ZXJ5LCBpbmRleCB9KTogV2hlcmVDbGF1c2UgPT4ge1xuICBjb25zdCBwYXR0ZXJucyA9IFtdO1xuICBsZXQgdmFsdWVzID0gW107XG4gIGNvbnN0IHNvcnRzID0gW107XG5cbiAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiBxdWVyeSkge1xuICAgIGNvbnN0IGlzQXJyYXlGaWVsZCA9IHNjaGVtYS5maWVsZHNcbiAgICAgICAgICAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV1cbiAgICAgICAgICAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5JztcbiAgICBjb25zdCBpbml0aWFsUGF0dGVybnNMZW5ndGggPSBwYXR0ZXJucy5sZW5ndGg7XG4gICAgY29uc3QgZmllbGRWYWx1ZSA9IHF1ZXJ5W2ZpZWxkTmFtZV07XG5cbiAgICAvLyBub3RoaW5naW4gdGhlIHNjaGVtYSwgaXQncyBnb25uYSBibG93IHVwXG4gICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0pIHtcbiAgICAgIC8vIGFzIGl0IHdvbid0IGV4aXN0XG4gICAgICBpZiAoZmllbGRWYWx1ZSAmJiBmaWVsZFZhbHVlLiRleGlzdHMgPT09IGZhbHNlKSB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgIGxldCBuYW1lID0gdHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCR7bmFtZX0gSVMgTlVMTGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGZpZWxkVmFsdWUuJGluKSB7XG4gICAgICAgICAgY29uc3QgaW5QYXR0ZXJucyA9IFtdO1xuICAgICAgICAgIG5hbWUgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhmaWVsZE5hbWUpLmpvaW4oJy0+Jyk7XG4gICAgICAgICAgZmllbGRWYWx1ZS4kaW4uZm9yRWFjaCgobGlzdEVsZW0pID0+IHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgbGlzdEVsZW0gPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgIGluUGF0dGVybnMucHVzaChgXCIke2xpc3RFbGVtfVwiYCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBpblBhdHRlcm5zLnB1c2goYCR7bGlzdEVsZW19YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgKCR7bmFtZX0pOjpqc29uYiBAPiAnWyR7aW5QYXR0ZXJucy5qb2luKCl9XSc6Ompzb25iYCk7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgICAgICAvLyBIYW5kbGUgbGF0ZXJcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAke25hbWV9ID0gJyR7ZmllbGRWYWx1ZX0nYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOVUxMYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAvLyBDYW4ndCBjYXN0IGJvb2xlYW4gdG8gZG91YmxlIHByZWNpc2lvblxuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ051bWJlcicpIHtcbiAgICAgICAgLy8gU2hvdWxkIGFsd2F5cyByZXR1cm4gemVybyByZXN1bHRzXG4gICAgICAgIGNvbnN0IE1BWF9JTlRfUExVU19PTkUgPSA5MjIzMzcyMDM2ODU0Nzc1ODA4O1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIE1BWF9JTlRfUExVU19PTkUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmIChbJyRvcicsICckbm9yJywgJyRhbmQnXS5pbmNsdWRlcyhmaWVsZE5hbWUpKSB7XG4gICAgICBjb25zdCBjbGF1c2VzID0gW107XG4gICAgICBjb25zdCBjbGF1c2VWYWx1ZXMgPSBbXTtcbiAgICAgIGZpZWxkVmFsdWUuZm9yRWFjaCgoc3ViUXVlcnkpID0+ICB7XG4gICAgICAgIGNvbnN0IGNsYXVzZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIHF1ZXJ5OiBzdWJRdWVyeSwgaW5kZXggfSk7XG4gICAgICAgIGlmIChjbGF1c2UucGF0dGVybi5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY2xhdXNlcy5wdXNoKGNsYXVzZS5wYXR0ZXJuKTtcbiAgICAgICAgICBjbGF1c2VWYWx1ZXMucHVzaCguLi5jbGF1c2UudmFsdWVzKTtcbiAgICAgICAgICBpbmRleCArPSBjbGF1c2UudmFsdWVzLmxlbmd0aDtcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIGNvbnN0IG9yT3JBbmQgPSBmaWVsZE5hbWUgPT09ICckYW5kJyA/ICcgQU5EICcgOiAnIE9SICc7XG4gICAgICBjb25zdCBub3QgPSBmaWVsZE5hbWUgPT09ICckbm9yJyA/ICcgTk9UICcgOiAnJztcblxuICAgICAgcGF0dGVybnMucHVzaChgJHtub3R9KCR7Y2xhdXNlcy5qb2luKG9yT3JBbmQpfSlgKTtcbiAgICAgIHZhbHVlcy5wdXNoKC4uLmNsYXVzZVZhbHVlcyk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJG5lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgZmllbGRWYWx1ZS4kbmUgPSBKU09OLnN0cmluZ2lmeShbZmllbGRWYWx1ZS4kbmVdKTtcbiAgICAgICAgcGF0dGVybnMucHVzaChgTk9UIGFycmF5X2NvbnRhaW5zKCQke2luZGV4fTpuYW1lLCAkJHtpbmRleCArIDF9KWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKGZpZWxkVmFsdWUuJG5lID09PSBudWxsKSB7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTk9UIE5VTExgKTtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gaWYgbm90IG51bGwsIHdlIG5lZWQgdG8gbWFudWFsbHkgZXhjbHVkZSBudWxsXG4gICAgICAgICAgcGF0dGVybnMucHVzaChgKCQke2luZGV4fTpuYW1lIDw+ICQke2luZGV4ICsgMX0gT1IgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTClgKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUT0RPOiBzdXBwb3J0IGFycmF5c1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLiRuZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cbiAgICBpZiAoZmllbGRWYWx1ZS4kZXEgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGVxID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5VTExgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuJGVxKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgaXNJbk9yTmluID0gQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRpbikgfHwgQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRuaW4pO1xuICAgIGlmIChBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUuJGluKSAmJlxuICAgICAgICBpc0FycmF5RmllbGQgJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmNvbnRlbnRzICYmXG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5jb250ZW50cy50eXBlID09PSAnU3RyaW5nJykge1xuICAgICAgY29uc3QgaW5QYXR0ZXJucyA9IFtdO1xuICAgICAgbGV0IGFsbG93TnVsbCA9IGZhbHNlO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgIGZpZWxkVmFsdWUuJGluLmZvckVhY2goKGxpc3RFbGVtLCBsaXN0SW5kZXgpID0+IHtcbiAgICAgICAgaWYgKGxpc3RFbGVtID09PSBudWxsKSB7XG4gICAgICAgICAgYWxsb3dOdWxsID0gdHJ1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YWx1ZXMucHVzaChsaXN0RWxlbSk7XG4gICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAkJHtpbmRleCArIDEgKyBsaXN0SW5kZXggLSAoYWxsb3dOdWxsID8gMSA6IDApfWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIGlmIChhbGxvd051bGwpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgKCQke2luZGV4fTpuYW1lIElTIE5VTEwgT1IgJCR7aW5kZXh9Om5hbWUgJiYgQVJSQVlbJHtpblBhdHRlcm5zLmpvaW4oKX1dKWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgJiYgQVJSQVlbJHtpblBhdHRlcm5zLmpvaW4oKX1dYCk7XG4gICAgICB9XG4gICAgICBpbmRleCA9IGluZGV4ICsgMSArIGluUGF0dGVybnMubGVuZ3RoO1xuICAgIH0gZWxzZSBpZiAoaXNJbk9yTmluKSB7XG4gICAgICB2YXIgY3JlYXRlQ29uc3RyYWludCA9IChiYXNlQXJyYXksIG5vdEluKSA9PiB7XG4gICAgICAgIGlmIChiYXNlQXJyYXkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IG5vdCA9IG5vdEluID8gJyBOT1QgJyA6ICcnO1xuICAgICAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCR7bm90fSBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoYmFzZUFycmF5KSk7XG4gICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBIYW5kbGUgTmVzdGVkIERvdCBOb3RhdGlvbiBBYm92ZVxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpblBhdHRlcm5zID0gW107XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgYmFzZUFycmF5LmZvckVhY2goKGxpc3RFbGVtLCBsaXN0SW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKGxpc3RFbGVtICE9PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgdmFsdWVzLnB1c2gobGlzdEVsZW0pO1xuICAgICAgICAgICAgICAgIGluUGF0dGVybnMucHVzaChgJCR7aW5kZXggKyAxICsgbGlzdEluZGV4fWApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lICR7bm90fSBJTiAoJHtpblBhdHRlcm5zLmpvaW4oKX0pYCk7XG4gICAgICAgICAgICBpbmRleCA9IGluZGV4ICsgMSArIGluUGF0dGVybnMubGVuZ3RoO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICghbm90SW4pIHtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5VTExgKTtcbiAgICAgICAgICBpbmRleCA9IGluZGV4ICsgMTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGZpZWxkVmFsdWUuJGluKSB7XG4gICAgICAgIGNyZWF0ZUNvbnN0cmFpbnQoXy5mbGF0TWFwKGZpZWxkVmFsdWUuJGluLCBlbHQgPT4gZWx0KSwgZmFsc2UpO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkVmFsdWUuJG5pbikge1xuICAgICAgICBjcmVhdGVDb25zdHJhaW50KF8uZmxhdE1hcChmaWVsZFZhbHVlLiRuaW4sIGVsdCA9PiBlbHQpLCB0cnVlKTtcbiAgICAgIH1cbiAgICB9IGVsc2UgaWYodHlwZW9mIGZpZWxkVmFsdWUuJGluICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCAkaW4gdmFsdWUnKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlLiRuaW4gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRuaW4gdmFsdWUnKTtcbiAgICB9XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRhbGwpICYmIGlzQXJyYXlGaWVsZCkge1xuICAgICAgaWYgKGlzQW55VmFsdWVSZWdleFN0YXJ0c1dpdGgoZmllbGRWYWx1ZS4kYWxsKSkge1xuICAgICAgICBpZiAoIWlzQWxsVmFsdWVzUmVnZXhPck5vbmUoZmllbGRWYWx1ZS4kYWxsKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdBbGwgJGFsbCB2YWx1ZXMgbXVzdCBiZSBvZiByZWdleCB0eXBlIG9yIG5vbmU6ICdcbiAgICAgICAgICAgICsgZmllbGRWYWx1ZS4kYWxsKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmllbGRWYWx1ZS4kYWxsLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBwcm9jZXNzUmVnZXhQYXR0ZXJuKGZpZWxkVmFsdWUuJGFsbFtpXS4kcmVnZXgpO1xuICAgICAgICAgIGZpZWxkVmFsdWUuJGFsbFtpXSA9IHZhbHVlLnN1YnN0cmluZygxKSArICclJztcbiAgICAgICAgfVxuICAgICAgICBwYXR0ZXJucy5wdXNoKGBhcnJheV9jb250YWluc19hbGxfcmVnZXgoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX06Ompzb25iKWApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnNfYWxsKCQke2luZGV4fTpuYW1lLCAkJHtpbmRleCArIDF9Ojpqc29uYilgKTtcbiAgICAgIH1cbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZS4kYWxsKSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kZXhpc3RzICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGV4aXN0cykge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOT1QgTlVMTGApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgfVxuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgIGluZGV4ICs9IDE7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGNvbnRhaW5lZEJ5KSB7XG4gICAgICBjb25zdCBhcnIgPSBmaWVsZFZhbHVlLiRjb250YWluZWRCeTtcbiAgICAgIGlmICghKGFyciBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJGNvbnRhaW5lZEJ5OiBzaG91bGQgYmUgYW4gYXJyYXlgXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIDxAICQke2luZGV4ICsgMX06Ompzb25iYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGFycikpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kdGV4dCkge1xuICAgICAgY29uc3Qgc2VhcmNoID0gZmllbGRWYWx1ZS4kdGV4dC4kc2VhcmNoO1xuICAgICAgbGV0IGxhbmd1YWdlID0gJ2VuZ2xpc2gnO1xuICAgICAgaWYgKHR5cGVvZiBzZWFyY2ggIT09ICdvYmplY3QnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJHNlYXJjaCwgc2hvdWxkIGJlIG9iamVjdGBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmICghc2VhcmNoLiR0ZXJtIHx8IHR5cGVvZiBzZWFyY2guJHRlcm0gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJHRlcm0sIHNob3VsZCBiZSBzdHJpbmdgXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoc2VhcmNoLiRsYW5ndWFnZSAmJiB0eXBlb2Ygc2VhcmNoLiRsYW5ndWFnZSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkbGFuZ3VhZ2UsIHNob3VsZCBiZSBzdHJpbmdgXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kbGFuZ3VhZ2UpIHtcbiAgICAgICAgbGFuZ3VhZ2UgPSBzZWFyY2guJGxhbmd1YWdlO1xuICAgICAgfVxuICAgICAgaWYgKHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSAmJiB0eXBlb2Ygc2VhcmNoLiRjYXNlU2Vuc2l0aXZlICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkY2FzZVNlbnNpdGl2ZSwgc2hvdWxkIGJlIGJvb2xlYW5gXG4gICAgICAgICk7XG4gICAgICB9IGVsc2UgaWYgKHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRjYXNlU2Vuc2l0aXZlIG5vdCBzdXBwb3J0ZWQsIHBsZWFzZSB1c2UgJHJlZ2V4IG9yIGNyZWF0ZSBhIHNlcGFyYXRlIGxvd2VyIGNhc2UgY29sdW1uLmBcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzZWFyY2guJGRpYWNyaXRpY1NlbnNpdGl2ZSAmJiB0eXBlb2Ygc2VhcmNoLiRkaWFjcml0aWNTZW5zaXRpdmUgIT09ICdib29sZWFuJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgIGBiYWQgJHRleHQ6ICRkaWFjcml0aWNTZW5zaXRpdmUsIHNob3VsZCBiZSBib29sZWFuYFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChzZWFyY2guJGRpYWNyaXRpY1NlbnNpdGl2ZSA9PT0gZmFsc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkZGlhY3JpdGljU2Vuc2l0aXZlIC0gZmFsc2Ugbm90IHN1cHBvcnRlZCwgaW5zdGFsbCBQb3N0Z3JlcyBVbmFjY2VudCBFeHRlbnNpb25gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBwYXR0ZXJucy5wdXNoKGB0b190c3ZlY3RvcigkJHtpbmRleH0sICQke2luZGV4ICsgMX06bmFtZSkgQEAgdG9fdHNxdWVyeSgkJHtpbmRleCArIDJ9LCAkJHtpbmRleCArIDN9KWApO1xuICAgICAgdmFsdWVzLnB1c2gobGFuZ3VhZ2UsIGZpZWxkTmFtZSwgbGFuZ3VhZ2UsIHNlYXJjaC4kdGVybSk7XG4gICAgICBpbmRleCArPSA0O1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLiRuZWFyU3BoZXJlKSB7XG4gICAgICBjb25zdCBwb2ludCA9IGZpZWxkVmFsdWUuJG5lYXJTcGhlcmU7XG4gICAgICBjb25zdCBkaXN0YW5jZSA9IGZpZWxkVmFsdWUuJG1heERpc3RhbmNlO1xuICAgICAgY29uc3QgZGlzdGFuY2VJbktNID0gZGlzdGFuY2UgKiA2MzcxICogMTAwMDtcbiAgICAgIHBhdHRlcm5zLnB1c2goYFNUX2Rpc3RhbmNlX3NwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pOjpnZW9tZXRyeSkgPD0gJCR7aW5kZXggKyAzfWApO1xuICAgICAgc29ydHMucHVzaChgU1RfZGlzdGFuY2Vfc3BoZXJlKCQke2luZGV4fTpuYW1lOjpnZW9tZXRyeSwgUE9JTlQoJCR7aW5kZXggKyAxfSwgJCR7aW5kZXggKyAyfSk6Omdlb21ldHJ5KSBBU0NgKVxuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlLCBkaXN0YW5jZUluS00pO1xuICAgICAgaW5kZXggKz0gNDtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kd2l0aGluICYmIGZpZWxkVmFsdWUuJHdpdGhpbi4kYm94KSB7XG4gICAgICBjb25zdCBib3ggPSBmaWVsZFZhbHVlLiR3aXRoaW4uJGJveDtcbiAgICAgIGNvbnN0IGxlZnQgPSBib3hbMF0ubG9uZ2l0dWRlO1xuICAgICAgY29uc3QgYm90dG9tID0gYm94WzBdLmxhdGl0dWRlO1xuICAgICAgY29uc3QgcmlnaHQgPSBib3hbMV0ubG9uZ2l0dWRlO1xuICAgICAgY29uc3QgdG9wID0gYm94WzFdLmxhdGl0dWRlO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZTo6cG9pbnQgPEAgJCR7aW5kZXggKyAxfTo6Ym94YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGAoKCR7bGVmdH0sICR7Ym90dG9tfSksICgke3JpZ2h0fSwgJHt0b3B9KSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJGdlb1dpdGhpbiAmJiBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJGNlbnRlclNwaGVyZSkge1xuICAgICAgY29uc3QgY2VudGVyU3BoZXJlID0gZmllbGRWYWx1ZS4kZ2VvV2l0aGluLiRjZW50ZXJTcGhlcmU7XG4gICAgICBpZiAoIShjZW50ZXJTcGhlcmUgaW5zdGFuY2VvZiBBcnJheSkgfHwgY2VudGVyU3BoZXJlLmxlbmd0aCA8IDIpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIHNob3VsZCBiZSBhbiBhcnJheSBvZiBQYXJzZS5HZW9Qb2ludCBhbmQgZGlzdGFuY2UnKTtcbiAgICAgIH1cbiAgICAgIC8vIEdldCBwb2ludCwgY29udmVydCB0byBnZW8gcG9pbnQgaWYgbmVjZXNzYXJ5IGFuZCB2YWxpZGF0ZVxuICAgICAgbGV0IHBvaW50ID0gY2VudGVyU3BoZXJlWzBdO1xuICAgICAgaWYgKHBvaW50IGluc3RhbmNlb2YgQXJyYXkgJiYgcG9pbnQubGVuZ3RoID09PSAyKSB7XG4gICAgICAgIHBvaW50ID0gbmV3IFBhcnNlLkdlb1BvaW50KHBvaW50WzFdLCBwb2ludFswXSk7XG4gICAgICB9IGVsc2UgaWYgKCFHZW9Qb2ludENvZGVyLmlzVmFsaWRKU09OKHBvaW50KSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgZ2VvIHBvaW50IGludmFsaWQnKTtcbiAgICAgIH1cbiAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludC5sYXRpdHVkZSwgcG9pbnQubG9uZ2l0dWRlKTtcbiAgICAgIC8vIEdldCBkaXN0YW5jZSBhbmQgdmFsaWRhdGVcbiAgICAgIGNvbnN0IGRpc3RhbmNlID0gY2VudGVyU3BoZXJlWzFdO1xuICAgICAgaWYoaXNOYU4oZGlzdGFuY2UpIHx8IGRpc3RhbmNlIDwgMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRjZW50ZXJTcGhlcmUgZGlzdGFuY2UgaW52YWxpZCcpO1xuICAgICAgfVxuICAgICAgY29uc3QgZGlzdGFuY2VJbktNID0gZGlzdGFuY2UgKiA2MzcxICogMTAwMDtcbiAgICAgIHBhdHRlcm5zLnB1c2goYFNUX2Rpc3RhbmNlX3NwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pOjpnZW9tZXRyeSkgPD0gJCR7aW5kZXggKyAzfWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlLCBkaXN0YW5jZUluS00pO1xuICAgICAgaW5kZXggKz0gNDtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kZ2VvV2l0aGluICYmIGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kcG9seWdvbikge1xuICAgICAgY29uc3QgcG9seWdvbiA9IGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kcG9seWdvbjtcbiAgICAgIGxldCBwb2ludHM7XG4gICAgICBpZiAodHlwZW9mIHBvbHlnb24gPT09ICdvYmplY3QnICYmIHBvbHlnb24uX190eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgaWYgKCFwb2x5Z29uLmNvb3JkaW5hdGVzIHx8IHBvbHlnb24uY29vcmRpbmF0ZXMubGVuZ3RoIDwgMykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgUG9seWdvbi5jb29yZGluYXRlcyBzaG91bGQgY29udGFpbiBhdCBsZWFzdCAzIGxvbi9sYXQgcGFpcnMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBwb2ludHMgPSBwb2x5Z29uLmNvb3JkaW5hdGVzO1xuICAgICAgfSBlbHNlIGlmICgocG9seWdvbiBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgICBpZiAocG9seWdvbi5sZW5ndGggPCAzKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkcG9seWdvbiBzaG91bGQgY29udGFpbiBhdCBsZWFzdCAzIEdlb1BvaW50cydcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHBvaW50cyA9IHBvbHlnb247XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJHBvbHlnb24gc2hvdWxkIGJlIFBvbHlnb24gb2JqZWN0IG9yIEFycmF5IG9mIFBhcnNlLkdlb1BvaW50XFwncydcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHBvaW50cyA9IHBvaW50cy5tYXAoKHBvaW50KSA9PiB7XG4gICAgICAgIGlmIChwb2ludCBpbnN0YW5jZW9mIEFycmF5ICYmIHBvaW50Lmxlbmd0aCA9PT0gMikge1xuICAgICAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludFsxXSwgcG9pbnRbMF0pO1xuICAgICAgICAgIHJldHVybiBgKCR7cG9pbnRbMF19LCAke3BvaW50WzFdfSlgO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgcG9pbnQgIT09ICdvYmplY3QnIHx8IHBvaW50Ll9fdHlwZSAhPT0gJ0dlb1BvaW50Jykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgJGdlb1dpdGhpbiB2YWx1ZScpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludC5sYXRpdHVkZSwgcG9pbnQubG9uZ2l0dWRlKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWA7XG4gICAgICB9KS5qb2luKCcsICcpO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZTo6cG9pbnQgPEAgJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBgKCR7cG9pbnRzfSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuICAgIGlmIChmaWVsZFZhbHVlLiRnZW9JbnRlcnNlY3RzICYmIGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50KSB7XG4gICAgICBjb25zdCBwb2ludCA9IGZpZWxkVmFsdWUuJGdlb0ludGVyc2VjdHMuJHBvaW50O1xuICAgICAgaWYgKHR5cGVvZiBwb2ludCAhPT0gJ29iamVjdCcgfHwgcG9pbnQuX190eXBlICE9PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvSW50ZXJzZWN0IHZhbHVlOyAkcG9pbnQgc2hvdWxkIGJlIEdlb1BvaW50J1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgfVxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWU6OnBvbHlnb24gQD4gJCR7aW5kZXggKyAxfTo6cG9pbnRgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgYCgke3BvaW50LmxvbmdpdHVkZX0sICR7cG9pbnQubGF0aXR1ZGV9KWApO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgIGxldCByZWdleCA9IGZpZWxkVmFsdWUuJHJlZ2V4O1xuICAgICAgbGV0IG9wZXJhdG9yID0gJ34nO1xuICAgICAgY29uc3Qgb3B0cyA9IGZpZWxkVmFsdWUuJG9wdGlvbnM7XG4gICAgICBpZiAob3B0cykge1xuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCdpJykgPj0gMCkge1xuICAgICAgICAgIG9wZXJhdG9yID0gJ34qJztcbiAgICAgICAgfVxuICAgICAgICBpZiAob3B0cy5pbmRleE9mKCd4JykgPj0gMCkge1xuICAgICAgICAgIHJlZ2V4ID0gcmVtb3ZlV2hpdGVTcGFjZShyZWdleCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgbmFtZSA9IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICByZWdleCA9IHByb2Nlc3NSZWdleFBhdHRlcm4ocmVnZXgpO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06cmF3ICR7b3BlcmF0b3J9ICckJHtpbmRleCArIDF9OnJhdydgKTtcbiAgICAgIHZhbHVlcy5wdXNoKG5hbWUsIHJlZ2V4KTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnMoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX0pYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoW2ZpZWxkVmFsdWVdKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuaXNvKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnR2VvUG9pbnQnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKCckJyArIGluZGV4ICsgJzpuYW1lIH49IFBPSU5UKCQnICsgKGluZGV4ICsgMSkgKyAnLCAkJyArIChpbmRleCArIDIpICsgJyknKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5sb25naXR1ZGUsIGZpZWxkVmFsdWUubGF0aXR1ZGUpO1xuICAgICAgaW5kZXggKz0gMztcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgY29uc3QgdmFsdWUgPSBjb252ZXJ0UG9seWdvblRvU1FMKGZpZWxkVmFsdWUuY29vcmRpbmF0ZXMpO1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgfj0gJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB2YWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cblxuICAgIE9iamVjdC5rZXlzKFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcikuZm9yRWFjaChjbXAgPT4ge1xuICAgICAgaWYgKGZpZWxkVmFsdWVbY21wXSB8fCBmaWVsZFZhbHVlW2NtcF0gPT09IDApIHtcbiAgICAgICAgY29uc3QgcGdDb21wYXJhdG9yID0gUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yW2NtcF07XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lICR7cGdDb21wYXJhdG9yfSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdG9Qb3N0Z3Jlc1ZhbHVlKGZpZWxkVmFsdWVbY21wXSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKGluaXRpYWxQYXR0ZXJuc0xlbmd0aCA9PT0gcGF0dGVybnMubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTiwgYFBvc3RncmVzIGRvZXNuJ3Qgc3VwcG9ydCB0aGlzIHF1ZXJ5IHR5cGUgeWV0ICR7SlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSl9YCk7XG4gICAgfVxuICB9XG4gIHZhbHVlcyA9IHZhbHVlcy5tYXAodHJhbnNmb3JtVmFsdWUpO1xuICByZXR1cm4geyBwYXR0ZXJuOiBwYXR0ZXJucy5qb2luKCcgQU5EICcpLCB2YWx1ZXMsIHNvcnRzIH07XG59XG5cbmV4cG9ydCBjbGFzcyBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyIGltcGxlbWVudHMgU3RvcmFnZUFkYXB0ZXIge1xuXG4gIGNhblNvcnRPbkpvaW5UYWJsZXM6IGJvb2xlYW47XG5cbiAgLy8gUHJpdmF0ZVxuICBfY29sbGVjdGlvblByZWZpeDogc3RyaW5nO1xuICBfY2xpZW50OiBhbnk7XG4gIF9wZ3A6IGFueTtcblxuICBjb25zdHJ1Y3Rvcih7XG4gICAgdXJpLFxuICAgIGNvbGxlY3Rpb25QcmVmaXggPSAnJyxcbiAgICBkYXRhYmFzZU9wdGlvbnNcbiAgfTogYW55KSB7XG4gICAgdGhpcy5fY29sbGVjdGlvblByZWZpeCA9IGNvbGxlY3Rpb25QcmVmaXg7XG4gICAgY29uc3QgeyBjbGllbnQsIHBncCB9ID0gY3JlYXRlQ2xpZW50KHVyaSwgZGF0YWJhc2VPcHRpb25zKTtcbiAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7XG4gICAgdGhpcy5fcGdwID0gcGdwO1xuICAgIHRoaXMuY2FuU29ydE9uSm9pblRhYmxlcyA9IGZhbHNlO1xuICB9XG5cbiAgaGFuZGxlU2h1dGRvd24oKSB7XG4gICAgaWYgKCF0aGlzLl9jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY2xpZW50LiRwb29sLmVuZCgpO1xuICB9XG5cbiAgX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMoY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIHJldHVybiBjb25uLm5vbmUoJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIFwiX1NDSEVNQVwiICggXCJjbGFzc05hbWVcIiB2YXJDaGFyKDEyMCksIFwic2NoZW1hXCIganNvbmIsIFwiaXNQYXJzZUNsYXNzXCIgYm9vbCwgUFJJTUFSWSBLRVkgKFwiY2xhc3NOYW1lXCIpICknKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvclxuICAgICAgICAgIHx8IGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvclxuICAgICAgICAgIHx8IGVycm9yLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlT2JqZWN0RXJyb3IpIHtcbiAgICAgICAgLy8gVGFibGUgYWxyZWFkeSBleGlzdHMsIG11c3QgaGF2ZSBiZWVuIGNyZWF0ZWQgYnkgYSBkaWZmZXJlbnQgcmVxdWVzdC4gSWdub3JlIGVycm9yLlxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG4gIGNsYXNzRXhpc3RzKG5hbWU6IHN0cmluZykge1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQub25lKCdTRUxFQ1QgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS50YWJsZXMgV0hFUkUgdGFibGVfbmFtZSA9ICQxKScsIFtuYW1lXSwgYSA9PiBhLmV4aXN0cyk7XG4gIH1cblxuICBzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMoY2xhc3NOYW1lOiBzdHJpbmcsIENMUHM6IGFueSkge1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQudGFzaygnc2V0LWNsYXNzLWxldmVsLXBlcm1pc3Npb25zJywgZnVuY3Rpb24gKiAodCkge1xuICAgICAgeWllbGQgc2VsZi5fZW5zdXJlU2NoZW1hQ29sbGVjdGlvbkV4aXN0cyh0KTtcbiAgICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWUsICdzY2hlbWEnLCAnY2xhc3NMZXZlbFBlcm1pc3Npb25zJywgSlNPTi5zdHJpbmdpZnkoQ0xQcyldO1xuICAgICAgeWllbGQgdC5ub25lKGBVUERBVEUgXCJfU0NIRU1BXCIgU0VUICQyOm5hbWUgPSBqc29uX29iamVjdF9zZXRfa2V5KCQyOm5hbWUsICQzOjp0ZXh0LCAkNDo6anNvbmIpIFdIRVJFIFwiY2xhc3NOYW1lXCI9JDFgLCB2YWx1ZXMpO1xuICAgIH0pO1xuICB9XG5cbiAgc2V0SW5kZXhlc1dpdGhTY2hlbWFGb3JtYXQoY2xhc3NOYW1lOiBzdHJpbmcsIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSwgZXhpc3RpbmdJbmRleGVzOiBhbnkgPSB7fSwgZmllbGRzOiBhbnksIGNvbm46ID9hbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25uID0gY29ubiB8fCB0aGlzLl9jbGllbnQ7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgaWYgKHN1Ym1pdHRlZEluZGV4ZXMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgIH1cbiAgICBpZiAoT2JqZWN0LmtleXMoZXhpc3RpbmdJbmRleGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgIGV4aXN0aW5nSW5kZXhlcyA9IHsgX2lkXzogeyBfaWQ6IDF9IH07XG4gICAgfVxuICAgIGNvbnN0IGRlbGV0ZWRJbmRleGVzID0gW107XG4gICAgY29uc3QgaW5zZXJ0ZWRJbmRleGVzID0gW107XG4gICAgT2JqZWN0LmtleXMoc3VibWl0dGVkSW5kZXhlcykuZm9yRWFjaChuYW1lID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc3VibWl0dGVkSW5kZXhlc1tuYW1lXTtcbiAgICAgIGlmIChleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCAhPT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksIGBJbmRleCAke25hbWV9IGV4aXN0cywgY2Fubm90IHVwZGF0ZS5gKTtcbiAgICAgIH1cbiAgICAgIGlmICghZXhpc3RpbmdJbmRleGVzW25hbWVdICYmIGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX1FVRVJZLCBgSW5kZXggJHtuYW1lfSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGRlbGV0ZS5gKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZC5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICBkZWxldGVkSW5kZXhlcy5wdXNoKG5hbWUpO1xuICAgICAgICBkZWxldGUgZXhpc3RpbmdJbmRleGVzW25hbWVdO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgT2JqZWN0LmtleXMoZmllbGQpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICBpZiAoIWZpZWxkcy5oYXNPd25Qcm9wZXJ0eShrZXkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEZpZWxkICR7a2V5fSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGFkZCBpbmRleC5gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBleGlzdGluZ0luZGV4ZXNbbmFtZV0gPSBmaWVsZDtcbiAgICAgICAgaW5zZXJ0ZWRJbmRleGVzLnB1c2goe1xuICAgICAgICAgIGtleTogZmllbGQsXG4gICAgICAgICAgbmFtZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgcmV0dXJuIGNvbm4udHgoJ3NldC1pbmRleGVzLXdpdGgtc2NoZW1hLWZvcm1hdCcsIGZ1bmN0aW9uICogKHQpIHtcbiAgICAgIGlmIChpbnNlcnRlZEluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICB5aWVsZCBzZWxmLmNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lLCBpbnNlcnRlZEluZGV4ZXMsIHQpO1xuICAgICAgfVxuICAgICAgaWYgKGRlbGV0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgeWllbGQgc2VsZi5kcm9wSW5kZXhlcyhjbGFzc05hbWUsIGRlbGV0ZWRJbmRleGVzLCB0KTtcbiAgICAgIH1cbiAgICAgIHlpZWxkIHNlbGYuX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHModCk7XG4gICAgICB5aWVsZCB0Lm5vbmUoJ1VQREFURSBcIl9TQ0hFTUFcIiBTRVQgJDI6bmFtZSA9IGpzb25fb2JqZWN0X3NldF9rZXkoJDI6bmFtZSwgJDM6OnRleHQsICQ0Ojpqc29uYikgV0hFUkUgXCJjbGFzc05hbWVcIj0kMScsIFtjbGFzc05hbWUsICdzY2hlbWEnLCAnaW5kZXhlcycsIEpTT04uc3RyaW5naWZ5KGV4aXN0aW5nSW5kZXhlcyldKTtcbiAgICB9KTtcbiAgfVxuXG4gIGNyZWF0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIGNvbm46ID9hbnkpIHtcbiAgICBjb25uID0gY29ubiB8fCB0aGlzLl9jbGllbnQ7XG4gICAgcmV0dXJuIGNvbm4udHgoJ2NyZWF0ZS1jbGFzcycsIHQgPT4ge1xuICAgICAgY29uc3QgcTEgPSB0aGlzLmNyZWF0ZVRhYmxlKGNsYXNzTmFtZSwgc2NoZW1hLCB0KTtcbiAgICAgIGNvbnN0IHEyID0gdC5ub25lKCdJTlNFUlQgSU5UTyBcIl9TQ0hFTUFcIiAoXCJjbGFzc05hbWVcIiwgXCJzY2hlbWFcIiwgXCJpc1BhcnNlQ2xhc3NcIikgVkFMVUVTICgkPGNsYXNzTmFtZT4sICQ8c2NoZW1hPiwgdHJ1ZSknLCB7IGNsYXNzTmFtZSwgc2NoZW1hIH0pO1xuICAgICAgY29uc3QgcTMgPSB0aGlzLnNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KGNsYXNzTmFtZSwgc2NoZW1hLmluZGV4ZXMsIHt9LCBzY2hlbWEuZmllbGRzLCB0KTtcbiAgICAgIHJldHVybiB0LmJhdGNoKFtxMSwgcTIsIHEzXSk7XG4gICAgfSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRvUGFyc2VTY2hlbWEoc2NoZW1hKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyID0+IHtcbiAgICAgICAgaWYgKGVyci5kYXRhWzBdLnJlc3VsdC5jb2RlID09PSBQb3N0Z3Jlc1RyYW5zYWN0aW9uQWJvcnRlZEVycm9yKSB7XG4gICAgICAgICAgZXJyID0gZXJyLmRhdGFbMV0ucmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yICYmIGVyci5kZXRhaWwuaW5jbHVkZXMoY2xhc3NOYW1lKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsIGBDbGFzcyAke2NsYXNzTmFtZX0gYWxyZWFkeSBleGlzdHMuYClcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnI7XG4gICAgICB9KVxuICB9XG5cbiAgLy8gSnVzdCBjcmVhdGUgYSB0YWJsZSwgZG8gbm90IGluc2VydCBpbiBzY2hlbWFcbiAgY3JlYXRlVGFibGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIGRlYnVnKCdjcmVhdGVUYWJsZScsIGNsYXNzTmFtZSwgc2NoZW1hKTtcbiAgICBjb25zdCB2YWx1ZXNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHBhdHRlcm5zQXJyYXkgPSBbXTtcbiAgICBjb25zdCBmaWVsZHMgPSBPYmplY3QuYXNzaWduKHt9LCBzY2hlbWEuZmllbGRzKTtcbiAgICBpZiAoY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICBmaWVsZHMuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0ID0ge3R5cGU6ICdEYXRlJ307XG4gICAgICBmaWVsZHMuX2VtYWlsX3ZlcmlmeV90b2tlbiA9IHt0eXBlOiAnU3RyaW5nJ307XG4gICAgICBmaWVsZHMuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0ID0ge3R5cGU6ICdEYXRlJ307XG4gICAgICBmaWVsZHMuX2ZhaWxlZF9sb2dpbl9jb3VudCA9IHt0eXBlOiAnTnVtYmVyJ307XG4gICAgICBmaWVsZHMuX3BlcmlzaGFibGVfdG9rZW4gPSB7dHlwZTogJ1N0cmluZyd9O1xuICAgICAgZmllbGRzLl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQgPSB7dHlwZTogJ0RhdGUnfTtcbiAgICAgIGZpZWxkcy5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IHt0eXBlOiAnRGF0ZSd9O1xuICAgICAgZmllbGRzLl9wYXNzd29yZF9oaXN0b3J5ID0geyB0eXBlOiAnQXJyYXknfTtcbiAgICB9XG4gICAgbGV0IGluZGV4ID0gMjtcbiAgICBjb25zdCByZWxhdGlvbnMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhmaWVsZHMpLmZvckVhY2goKGZpZWxkTmFtZSkgPT4ge1xuICAgICAgY29uc3QgcGFyc2VUeXBlID0gZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICAvLyBTa2lwIHdoZW4gaXQncyBhIHJlbGF0aW9uXG4gICAgICAvLyBXZSdsbCBjcmVhdGUgdGhlIHRhYmxlcyBsYXRlclxuICAgICAgaWYgKHBhcnNlVHlwZS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHJlbGF0aW9ucy5wdXNoKGZpZWxkTmFtZSlcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKFsnX3JwZXJtJywgJ193cGVybSddLmluZGV4T2YoZmllbGROYW1lKSA+PSAwKSB7XG4gICAgICAgIHBhcnNlVHlwZS5jb250ZW50cyA9IHsgdHlwZTogJ1N0cmluZycgfTtcbiAgICAgIH1cbiAgICAgIHZhbHVlc0FycmF5LnB1c2goZmllbGROYW1lKTtcbiAgICAgIHZhbHVlc0FycmF5LnB1c2gocGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUocGFyc2VUeXBlKSk7XG4gICAgICBwYXR0ZXJuc0FycmF5LnB1c2goYCQke2luZGV4fTpuYW1lICQke2luZGV4ICsgMX06cmF3YCk7XG4gICAgICBpZiAoZmllbGROYW1lID09PSAnb2JqZWN0SWQnKSB7XG4gICAgICAgIHBhdHRlcm5zQXJyYXkucHVzaChgUFJJTUFSWSBLRVkgKCQke2luZGV4fTpuYW1lKWApXG4gICAgICB9XG4gICAgICBpbmRleCA9IGluZGV4ICsgMjtcbiAgICB9KTtcbiAgICBjb25zdCBxcyA9IGBDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyAkMTpuYW1lICgke3BhdHRlcm5zQXJyYXkuam9pbigpfSlgO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWUsIC4uLnZhbHVlc0FycmF5XTtcblxuICAgIHJldHVybiBjb25uLnRhc2soJ2NyZWF0ZS10YWJsZScsIGZ1bmN0aW9uICogKHQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHlpZWxkIHNlbGYuX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHModCk7XG4gICAgICAgIHlpZWxkIHQubm9uZShxcywgdmFsdWVzKTtcbiAgICAgIH0gY2F0Y2goZXJyb3IpIHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvcikge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIC8vIEVMU0U6IFRhYmxlIGFscmVhZHkgZXhpc3RzLCBtdXN0IGhhdmUgYmVlbiBjcmVhdGVkIGJ5IGEgZGlmZmVyZW50IHJlcXVlc3QuIElnbm9yZSB0aGUgZXJyb3IuXG4gICAgICB9XG4gICAgICB5aWVsZCB0LnR4KCdjcmVhdGUtdGFibGUtdHgnLCB0eCA9PiB7XG4gICAgICAgIHJldHVybiB0eC5iYXRjaChyZWxhdGlvbnMubWFwKGZpZWxkTmFtZSA9PiB7XG4gICAgICAgICAgcmV0dXJuIHR4Lm5vbmUoJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTICQ8am9pblRhYmxlOm5hbWU+IChcInJlbGF0ZWRJZFwiIHZhckNoYXIoMTIwKSwgXCJvd25pbmdJZFwiIHZhckNoYXIoMTIwKSwgUFJJTUFSWSBLRVkoXCJyZWxhdGVkSWRcIiwgXCJvd25pbmdJZFwiKSApJywge2pvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gfSk7XG4gICAgICAgIH0pKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgc2NoZW1hVXBncmFkZShjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiBhbnkpIHtcbiAgICBkZWJ1Zygnc2NoZW1hVXBncmFkZScsIHsgY2xhc3NOYW1lLCBzY2hlbWEgfSk7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuXG4gICAgcmV0dXJuIGNvbm4udHgoJ3NjaGVtYS11cGdyYWRlJywgZnVuY3Rpb24gKiAodCkge1xuICAgICAgY29uc3QgY29sdW1ucyA9IHlpZWxkIHQubWFwKCdTRUxFQ1QgY29sdW1uX25hbWUgRlJPTSBpbmZvcm1hdGlvbl9zY2hlbWEuY29sdW1ucyBXSEVSRSB0YWJsZV9uYW1lID0gJDxjbGFzc05hbWU+JywgeyBjbGFzc05hbWUgfSwgYSA9PiBhLmNvbHVtbl9uYW1lKTtcbiAgICAgIGNvbnN0IG5ld0NvbHVtbnMgPSBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKVxuICAgICAgICAuZmlsdGVyKGl0ZW0gPT4gY29sdW1ucy5pbmRleE9mKGl0ZW0pID09PSAtMSlcbiAgICAgICAgLm1hcChmaWVsZE5hbWUgPT4gc2VsZi5hZGRGaWVsZElmTm90RXhpc3RzKGNsYXNzTmFtZSwgZmllbGROYW1lLCBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0sIHQpKTtcblxuICAgICAgeWllbGQgdC5iYXRjaChuZXdDb2x1bW5zKTtcbiAgICB9KTtcbiAgfVxuXG4gIGFkZEZpZWxkSWZOb3RFeGlzdHMoY2xhc3NOYW1lOiBzdHJpbmcsIGZpZWxkTmFtZTogc3RyaW5nLCB0eXBlOiBhbnksIGNvbm46IGFueSkge1xuICAgIC8vIFRPRE86IE11c3QgYmUgcmV2aXNlZCBmb3IgaW52YWxpZCBsb2dpYy4uLlxuICAgIGRlYnVnKCdhZGRGaWVsZElmTm90RXhpc3RzJywge2NsYXNzTmFtZSwgZmllbGROYW1lLCB0eXBlfSk7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIHJldHVybiBjb25uLnR4KCdhZGQtZmllbGQtaWYtbm90LWV4aXN0cycsIGZ1bmN0aW9uICogKHQpIHtcbiAgICAgIGlmICh0eXBlLnR5cGUgIT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICB5aWVsZCB0Lm5vbmUoJ0FMVEVSIFRBQkxFICQ8Y2xhc3NOYW1lOm5hbWU+IEFERCBDT0xVTU4gJDxmaWVsZE5hbWU6bmFtZT4gJDxwb3N0Z3Jlc1R5cGU6cmF3PicsIHtcbiAgICAgICAgICAgIGNsYXNzTmFtZSxcbiAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgIHBvc3RncmVzVHlwZTogcGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUodHlwZSlcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBjYXRjaChlcnJvcikge1xuICAgICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICAgIHJldHVybiB5aWVsZCBzZWxmLmNyZWF0ZUNsYXNzKGNsYXNzTmFtZSwge2ZpZWxkczoge1tmaWVsZE5hbWVdOiB0eXBlfX0sIHQpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvcikge1xuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIENvbHVtbiBhbHJlYWR5IGV4aXN0cywgY3JlYXRlZCBieSBvdGhlciByZXF1ZXN0LiBDYXJyeSBvbiB0byBzZWUgaWYgaXQncyB0aGUgcmlnaHQgdHlwZS5cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgeWllbGQgdC5ub25lKCdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyAkPGpvaW5UYWJsZTpuYW1lPiAoXCJyZWxhdGVkSWRcIiB2YXJDaGFyKDEyMCksIFwib3duaW5nSWRcIiB2YXJDaGFyKDEyMCksIFBSSU1BUlkgS0VZKFwicmVsYXRlZElkXCIsIFwib3duaW5nSWRcIikgKScsIHtqb2luVGFibGU6IGBfSm9pbjoke2ZpZWxkTmFtZX06JHtjbGFzc05hbWV9YH0pO1xuICAgICAgfVxuXG4gICAgICBjb25zdCByZXN1bHQgPSB5aWVsZCB0LmFueSgnU0VMRUNUIFwic2NoZW1hXCIgRlJPTSBcIl9TQ0hFTUFcIiBXSEVSRSBcImNsYXNzTmFtZVwiID0gJDxjbGFzc05hbWU+IGFuZCAoXCJzY2hlbWFcIjo6anNvbi0+XFwnZmllbGRzXFwnLT4kPGZpZWxkTmFtZT4pIGlzIG5vdCBudWxsJywge2NsYXNzTmFtZSwgZmllbGROYW1lfSk7XG5cbiAgICAgIGlmIChyZXN1bHRbMF0pIHtcbiAgICAgICAgdGhyb3cgJ0F0dGVtcHRlZCB0byBhZGQgYSBmaWVsZCB0aGF0IGFscmVhZHkgZXhpc3RzJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBge2ZpZWxkcywke2ZpZWxkTmFtZX19YDtcbiAgICAgICAgeWllbGQgdC5ub25lKCdVUERBVEUgXCJfU0NIRU1BXCIgU0VUIFwic2NoZW1hXCI9anNvbmJfc2V0KFwic2NoZW1hXCIsICQ8cGF0aD4sICQ8dHlwZT4pICBXSEVSRSBcImNsYXNzTmFtZVwiPSQ8Y2xhc3NOYW1lPicsIHtwYXRoLCB0eXBlLCBjbGFzc05hbWV9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3BlcmF0aW9ucyA9IFtcbiAgICAgIHtxdWVyeTogYERST1AgVEFCTEUgSUYgRVhJU1RTICQxOm5hbWVgLCB2YWx1ZXM6IFtjbGFzc05hbWVdfSxcbiAgICAgIHtxdWVyeTogYERFTEVURSBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsIHZhbHVlczogW2NsYXNzTmFtZV19XG4gICAgXTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LnR4KHQgPT4gdC5ub25lKHRoaXMuX3BncC5oZWxwZXJzLmNvbmNhdChvcGVyYXRpb25zKSkpXG4gICAgICAudGhlbigoKSA9PiBjbGFzc05hbWUuaW5kZXhPZignX0pvaW46JykgIT0gMCk7IC8vIHJlc29sdmVzIHdpdGggZmFsc2Ugd2hlbiBfSm9pbiB0YWJsZVxuICB9XG5cbiAgLy8gRGVsZXRlIGFsbCBkYXRhIGtub3duIHRvIHRoaXMgYWRhcHRlci4gVXNlZCBmb3IgdGVzdGluZy5cbiAgZGVsZXRlQWxsQ2xhc3NlcygpIHtcbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcbiAgICBjb25zdCBoZWxwZXJzID0gdGhpcy5fcGdwLmhlbHBlcnM7XG4gICAgZGVidWcoJ2RlbGV0ZUFsbENsYXNzZXMnKTtcblxuICAgIHJldHVybiB0aGlzLl9jbGllbnQudGFzaygnZGVsZXRlLWFsbC1jbGFzc2VzJywgZnVuY3Rpb24gKiAodCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzdWx0cyA9IHlpZWxkIHQuYW55KCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiJyk7XG4gICAgICAgIGNvbnN0IGpvaW5zID0gcmVzdWx0cy5yZWR1Y2UoKGxpc3Q6IEFycmF5PHN0cmluZz4sIHNjaGVtYTogYW55KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIGxpc3QuY29uY2F0KGpvaW5UYWJsZXNGb3JTY2hlbWEoc2NoZW1hLnNjaGVtYSkpO1xuICAgICAgICB9LCBbXSk7XG4gICAgICAgIGNvbnN0IGNsYXNzZXMgPSBbJ19TQ0hFTUEnLCAnX1B1c2hTdGF0dXMnLCAnX0pvYlN0YXR1cycsICdfSm9iU2NoZWR1bGUnLCAnX0hvb2tzJywgJ19HbG9iYWxDb25maWcnLCAnX0F1ZGllbmNlJywgLi4ucmVzdWx0cy5tYXAocmVzdWx0ID0+IHJlc3VsdC5jbGFzc05hbWUpLCAuLi5qb2luc107XG4gICAgICAgIGNvbnN0IHF1ZXJpZXMgPSBjbGFzc2VzLm1hcChjbGFzc05hbWUgPT4gKHtxdWVyeTogJ0RST1AgVEFCTEUgSUYgRVhJU1RTICQ8Y2xhc3NOYW1lOm5hbWU+JywgdmFsdWVzOiB7Y2xhc3NOYW1lfX0pKTtcbiAgICAgICAgeWllbGQgdC50eCh0eCA9PiB0eC5ub25lKGhlbHBlcnMuY29uY2F0KHF1ZXJpZXMpKSk7XG4gICAgICB9IGNhdGNoKGVycm9yKSB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICAvLyBObyBfU0NIRU1BIGNvbGxlY3Rpb24uIERvbid0IGRlbGV0ZSBhbnl0aGluZy5cbiAgICAgIH1cbiAgICB9KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBkZWJ1ZyhgZGVsZXRlQWxsQ2xhc3NlcyBkb25lIGluICR7bmV3IERhdGUoKS5nZXRUaW1lKCkgLSBub3d9YCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIFJlbW92ZSB0aGUgY29sdW1uIGFuZCBhbGwgdGhlIGRhdGEuIEZvciBSZWxhdGlvbnMsIHRoZSBfSm9pbiBjb2xsZWN0aW9uIGlzIGhhbmRsZWRcbiAgLy8gc3BlY2lhbGx5LCB0aGlzIGZ1bmN0aW9uIGRvZXMgbm90IGRlbGV0ZSBfSm9pbiBjb2x1bW5zLiBJdCBzaG91bGQsIGhvd2V2ZXIsIGluZGljYXRlXG4gIC8vIHRoYXQgdGhlIHJlbGF0aW9uIGZpZWxkcyBkb2VzIG5vdCBleGlzdCBhbnltb3JlLiBJbiBtb25nbywgdGhpcyBtZWFucyByZW1vdmluZyBpdCBmcm9tXG4gIC8vIHRoZSBfU0NIRU1BIGNvbGxlY3Rpb24uICBUaGVyZSBzaG91bGQgYmUgbm8gYWN0dWFsIGRhdGEgaW4gdGhlIGNvbGxlY3Rpb24gdW5kZXIgdGhlIHNhbWUgbmFtZVxuICAvLyBhcyB0aGUgcmVsYXRpb24gY29sdW1uLCBzbyBpdCdzIGZpbmUgdG8gYXR0ZW1wdCB0byBkZWxldGUgaXQuIElmIHRoZSBmaWVsZHMgbGlzdGVkIHRvIGJlXG4gIC8vIGRlbGV0ZWQgZG8gbm90IGV4aXN0LCB0aGlzIGZ1bmN0aW9uIHNob3VsZCByZXR1cm4gc3VjY2Vzc2Z1bGx5IGFueXdheXMuIENoZWNraW5nIGZvclxuICAvLyBhdHRlbXB0cyB0byBkZWxldGUgbm9uLWV4aXN0ZW50IGZpZWxkcyBpcyB0aGUgcmVzcG9uc2liaWxpdHkgb2YgUGFyc2UgU2VydmVyLlxuXG4gIC8vIFRoaXMgZnVuY3Rpb24gaXMgbm90IG9ibGlnYXRlZCB0byBkZWxldGUgZmllbGRzIGF0b21pY2FsbHkuIEl0IGlzIGdpdmVuIHRoZSBmaWVsZFxuICAvLyBuYW1lcyBpbiBhIGxpc3Qgc28gdGhhdCBkYXRhYmFzZXMgdGhhdCBhcmUgY2FwYWJsZSBvZiBkZWxldGluZyBmaWVsZHMgYXRvbWljYWxseVxuICAvLyBtYXkgZG8gc28uXG5cbiAgLy8gUmV0dXJucyBhIFByb21pc2UuXG4gIGRlbGV0ZUZpZWxkcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBmaWVsZE5hbWVzOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGRlYnVnKCdkZWxldGVGaWVsZHMnLCBjbGFzc05hbWUsIGZpZWxkTmFtZXMpO1xuICAgIGZpZWxkTmFtZXMgPSBmaWVsZE5hbWVzLnJlZHVjZSgobGlzdDogQXJyYXk8c3RyaW5nPiwgZmllbGROYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdXG4gICAgICBpZiAoZmllbGQudHlwZSAhPT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBsaXN0LnB1c2goZmllbGROYW1lKTtcbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICByZXR1cm4gbGlzdDtcbiAgICB9LCBbXSk7XG5cbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lLCAuLi5maWVsZE5hbWVzXTtcbiAgICBjb25zdCBjb2x1bW5zID0gZmllbGROYW1lcy5tYXAoKG5hbWUsIGlkeCkgPT4ge1xuICAgICAgcmV0dXJuIGAkJHtpZHggKyAyfTpuYW1lYDtcbiAgICB9KS5qb2luKCcsIERST1AgQ09MVU1OJyk7XG5cbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LnR4KCdkZWxldGUtZmllbGRzJywgZnVuY3Rpb24gKiAodCkge1xuICAgICAgeWllbGQgdC5ub25lKCdVUERBVEUgXCJfU0NIRU1BXCIgU0VUIFwic2NoZW1hXCI9JDxzY2hlbWE+IFdIRVJFIFwiY2xhc3NOYW1lXCI9JDxjbGFzc05hbWU+Jywge3NjaGVtYSwgY2xhc3NOYW1lfSk7XG4gICAgICBpZiAodmFsdWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgeWllbGQgdC5ub25lKGBBTFRFUiBUQUJMRSAkMTpuYW1lIERST1AgQ09MVU1OICR7Y29sdW1uc31gLCB2YWx1ZXMpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgYWxsIHNjaGVtYXMga25vd24gdG8gdGhpcyBhZGFwdGVyLCBpbiBQYXJzZSBmb3JtYXQuIEluIGNhc2UgdGhlXG4gIC8vIHNjaGVtYXMgY2Fubm90IGJlIHJldHJpZXZlZCwgcmV0dXJucyBhIHByb21pc2UgdGhhdCByZWplY3RzLiBSZXF1aXJlbWVudHMgZm9yIHRoZVxuICAvLyByZWplY3Rpb24gcmVhc29uIGFyZSBUQkQuXG4gIGdldEFsbENsYXNzZXMoKSB7XG4gICAgY29uc3Qgc2VsZiA9IHRoaXM7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC50YXNrKCdnZXQtYWxsLWNsYXNzZXMnLCBmdW5jdGlvbiAqICh0KSB7XG4gICAgICB5aWVsZCBzZWxmLl9lbnN1cmVTY2hlbWFDb2xsZWN0aW9uRXhpc3RzKHQpO1xuICAgICAgcmV0dXJuIHlpZWxkIHQubWFwKCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiJywgbnVsbCwgcm93ID0+IHRvUGFyc2VTY2hlbWEoeyBjbGFzc05hbWU6IHJvdy5jbGFzc05hbWUsIC4uLnJvdy5zY2hlbWEgfSkpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gUmV0dXJuIGEgcHJvbWlzZSBmb3IgdGhlIHNjaGVtYSB3aXRoIHRoZSBnaXZlbiBuYW1lLCBpbiBQYXJzZSBmb3JtYXQuIElmXG4gIC8vIHRoaXMgYWRhcHRlciBkb2Vzbid0IGtub3cgYWJvdXQgdGhlIHNjaGVtYSwgcmV0dXJuIGEgcHJvbWlzZSB0aGF0IHJlamVjdHMgd2l0aFxuICAvLyB1bmRlZmluZWQgYXMgdGhlIHJlYXNvbi5cbiAgZ2V0Q2xhc3MoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICBkZWJ1ZygnZ2V0Q2xhc3MnLCBjbGFzc05hbWUpO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQuYW55KCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCI9JDxjbGFzc05hbWU+JywgeyBjbGFzc05hbWUgfSlcbiAgICAgIC50aGVuKHJlc3VsdCA9PiB7XG4gICAgICAgIGlmIChyZXN1bHQubGVuZ3RoICE9PSAxKSB7XG4gICAgICAgICAgdGhyb3cgdW5kZWZpbmVkO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiByZXN1bHRbMF0uc2NoZW1hO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHRvUGFyc2VTY2hlbWEpO1xuICB9XG5cbiAgLy8gVE9ETzogcmVtb3ZlIHRoZSBtb25nbyBmb3JtYXQgZGVwZW5kZW5jeSBpbiB0aGUgcmV0dXJuIHZhbHVlXG4gIGNyZWF0ZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBvYmplY3Q6IGFueSkge1xuICAgIGRlYnVnKCdjcmVhdGVPYmplY3QnLCBjbGFzc05hbWUsIG9iamVjdCk7XG4gICAgbGV0IGNvbHVtbnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGdlb1BvaW50cyA9IHt9O1xuXG4gICAgb2JqZWN0ID0gaGFuZGxlRG90RmllbGRzKG9iamVjdCk7XG5cbiAgICB2YWxpZGF0ZUtleXMob2JqZWN0KTtcblxuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBhdXRoRGF0YU1hdGNoID0gZmllbGROYW1lLm1hdGNoKC9eX2F1dGhfZGF0YV8oW2EtekEtWjAtOV9dKykkLyk7XG4gICAgICBpZiAoYXV0aERhdGFNYXRjaCkge1xuICAgICAgICB2YXIgcHJvdmlkZXIgPSBhdXRoRGF0YU1hdGNoWzFdO1xuICAgICAgICBvYmplY3RbJ2F1dGhEYXRhJ10gPSBvYmplY3RbJ2F1dGhEYXRhJ10gfHwge307XG4gICAgICAgIG9iamVjdFsnYXV0aERhdGEnXVtwcm92aWRlcl0gPSBvYmplY3RbZmllbGROYW1lXTtcbiAgICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBmaWVsZE5hbWUgPSAnYXV0aERhdGEnO1xuICAgICAgfVxuXG4gICAgICBjb2x1bW5zQXJyYXkucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGlmIChmaWVsZE5hbWUgPT09ICdfZW1haWxfdmVyaWZ5X3Rva2VuJyB8fFxuICAgICAgICAgICAgZmllbGROYW1lID09PSAnX2ZhaWxlZF9sb2dpbl9jb3VudCcgfHxcbiAgICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19wZXJpc2hhYmxlX3Rva2VuJyB8fFxuICAgICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2hpc3RvcnknKXtcbiAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChmaWVsZE5hbWUgPT09ICdfZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQnKSB7XG4gICAgICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdKSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdLmlzbyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gobnVsbCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ19hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCcgfHxcbiAgICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnIHx8XG4gICAgICAgICAgICBmaWVsZE5hbWUgPT09ICdfcGFzc3dvcmRfY2hhbmdlZF9hdCcpIHtcbiAgICAgICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0uaXNvKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChudWxsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSkge1xuICAgICAgY2FzZSAnRGF0ZSc6XG4gICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0uaXNvKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0ub2JqZWN0SWQpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgICAgaWYgKFsnX3JwZXJtJywgJ193cGVybSddLmluZGV4T2YoZmllbGROYW1lKSA+PSAwKSB7XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChKU09OLnN0cmluZ2lmeShvYmplY3RbZmllbGROYW1lXSkpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnT2JqZWN0JzpcbiAgICAgIGNhc2UgJ0J5dGVzJzpcbiAgICAgIGNhc2UgJ1N0cmluZyc6XG4gICAgICBjYXNlICdOdW1iZXInOlxuICAgICAgY2FzZSAnQm9vbGVhbic6XG4gICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ0ZpbGUnOlxuICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdLm5hbWUpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ1BvbHlnb24nOiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChvYmplY3RbZmllbGROYW1lXS5jb29yZGluYXRlcyk7XG4gICAgICAgIHZhbHVlc0FycmF5LnB1c2godmFsdWUpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNhc2UgJ0dlb1BvaW50JzpcbiAgICAgICAgLy8gcG9wIHRoZSBwb2ludCBhbmQgcHJvY2VzcyBsYXRlclxuICAgICAgICBnZW9Qb2ludHNbZmllbGROYW1lXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBjb2x1bW5zQXJyYXkucG9wKCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgYFR5cGUgJHtzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZX0gbm90IHN1cHBvcnRlZCB5ZXRgO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29sdW1uc0FycmF5ID0gY29sdW1uc0FycmF5LmNvbmNhdChPYmplY3Qua2V5cyhnZW9Qb2ludHMpKTtcbiAgICBjb25zdCBpbml0aWFsVmFsdWVzID0gdmFsdWVzQXJyYXkubWFwKCh2YWwsIGluZGV4KSA9PiB7XG4gICAgICBsZXQgdGVybWluYXRpb24gPSAnJztcbiAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGNvbHVtbnNBcnJheVtpbmRleF07XG4gICAgICBpZiAoWydfcnBlcm0nLCdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6OnRleHRbXSc7XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5Jykge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6Ompzb25iJztcbiAgICAgIH1cbiAgICAgIHJldHVybiBgJCR7aW5kZXggKyAyICsgY29sdW1uc0FycmF5Lmxlbmd0aH0ke3Rlcm1pbmF0aW9ufWA7XG4gICAgfSk7XG4gICAgY29uc3QgZ2VvUG9pbnRzSW5qZWN0cyA9IE9iamVjdC5rZXlzKGdlb1BvaW50cykubWFwKChrZXkpID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gZ2VvUG9pbnRzW2tleV07XG4gICAgICB2YWx1ZXNBcnJheS5wdXNoKHZhbHVlLmxvbmdpdHVkZSwgdmFsdWUubGF0aXR1ZGUpO1xuICAgICAgY29uc3QgbCA9IHZhbHVlc0FycmF5Lmxlbmd0aCArIGNvbHVtbnNBcnJheS5sZW5ndGg7XG4gICAgICByZXR1cm4gYFBPSU5UKCQke2x9LCAkJHtsICsgMX0pYDtcbiAgICB9KTtcblxuICAgIGNvbnN0IGNvbHVtbnNQYXR0ZXJuID0gY29sdW1uc0FycmF5Lm1hcCgoY29sLCBpbmRleCkgPT4gYCQke2luZGV4ICsgMn06bmFtZWApLmpvaW4oKTtcbiAgICBjb25zdCB2YWx1ZXNQYXR0ZXJuID0gaW5pdGlhbFZhbHVlcy5jb25jYXQoZ2VvUG9pbnRzSW5qZWN0cykuam9pbigpXG5cbiAgICBjb25zdCBxcyA9IGBJTlNFUlQgSU5UTyAkMTpuYW1lICgke2NvbHVtbnNQYXR0ZXJufSkgVkFMVUVTICgke3ZhbHVlc1BhdHRlcm59KWBcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lLCAuLi5jb2x1bW5zQXJyYXksIC4uLnZhbHVlc0FycmF5XVxuICAgIGRlYnVnKHFzLCB2YWx1ZXMpO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQubm9uZShxcywgdmFsdWVzKVxuICAgICAgLnRoZW4oKCkgPT4gKHsgb3BzOiBbb2JqZWN0XSB9KSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQb3N0Z3Jlc1VuaXF1ZUluZGV4VmlvbGF0aW9uRXJyb3IpIHtcbiAgICAgICAgICBjb25zdCBlcnIgPSBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLCAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCcpO1xuICAgICAgICAgIGVyci51bmRlcmx5aW5nRXJyb3IgPSBlcnJvcjtcbiAgICAgICAgICBpZiAoZXJyb3IuY29uc3RyYWludCkge1xuICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGVycm9yLmNvbnN0cmFpbnQubWF0Y2goL3VuaXF1ZV8oW2EtekEtWl0rKS8pO1xuICAgICAgICAgICAgaWYgKG1hdGNoZXMgJiYgQXJyYXkuaXNBcnJheShtYXRjaGVzKSkge1xuICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IG1hdGNoZXNbMV0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgZXJyb3IgPSBlcnI7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbGwgb2JqZWN0cyB0aGF0IG1hdGNoIHRoZSBnaXZlbiBQYXJzZSBRdWVyeS5cbiAgLy8gSWYgbm8gb2JqZWN0cyBtYXRjaCwgcmVqZWN0IHdpdGggT0JKRUNUX05PVF9GT1VORC4gSWYgb2JqZWN0cyBhcmUgZm91bmQgYW5kIGRlbGV0ZWQsIHJlc29sdmUgd2l0aCB1bmRlZmluZWQuXG4gIC8vIElmIHRoZXJlIGlzIHNvbWUgb3RoZXIgZXJyb3IsIHJlamVjdCB3aXRoIElOVEVSTkFMX1NFUlZFUl9FUlJPUi5cbiAgZGVsZXRlT2JqZWN0c0J5UXVlcnkoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSkge1xuICAgIGRlYnVnKCdkZWxldGVPYmplY3RzQnlRdWVyeScsIGNsYXNzTmFtZSwgcXVlcnkpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IGluZGV4ID0gMjtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIGluZGV4LCBxdWVyeSB9KVxuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG4gICAgaWYgKE9iamVjdC5rZXlzKHF1ZXJ5KS5sZW5ndGggPT09IDApIHtcbiAgICAgIHdoZXJlLnBhdHRlcm4gPSAnVFJVRSc7XG4gICAgfVxuICAgIGNvbnN0IHFzID0gYFdJVEggZGVsZXRlZCBBUyAoREVMRVRFIEZST00gJDE6bmFtZSBXSEVSRSAke3doZXJlLnBhdHRlcm59IFJFVFVSTklORyAqKSBTRUxFQ1QgY291bnQoKikgRlJPTSBkZWxldGVkYDtcbiAgICBkZWJ1ZyhxcywgdmFsdWVzKTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm9uZShxcywgdmFsdWVzICwgYSA9PiArYS5jb3VudClcbiAgICAgIC50aGVuKGNvdW50ID0+IHtcbiAgICAgICAgaWYgKGNvdW50ID09PSAwKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLk9CSkVDVF9OT1RfRk9VTkQsICdPYmplY3Qgbm90IGZvdW5kLicpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJldHVybiBjb3VudDtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICAvLyBFTFNFOiBEb24ndCBkZWxldGUgYW55dGhpbmcgaWYgZG9lc24ndCBleGlzdFxuICAgICAgfSk7XG4gIH1cbiAgLy8gUmV0dXJuIHZhbHVlIG5vdCBjdXJyZW50bHkgd2VsbCBzcGVjaWZpZWQuXG4gIGZpbmRPbmVBbmRVcGRhdGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgcXVlcnk6IFF1ZXJ5VHlwZSwgdXBkYXRlOiBhbnkpOiBQcm9taXNlPGFueT4ge1xuICAgIGRlYnVnKCdmaW5kT25lQW5kVXBkYXRlJywgY2xhc3NOYW1lLCBxdWVyeSwgdXBkYXRlKTtcbiAgICByZXR1cm4gdGhpcy51cGRhdGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHVwZGF0ZSlcbiAgICAgIC50aGVuKCh2YWwpID0+IHZhbFswXSk7XG4gIH1cblxuICAvLyBBcHBseSB0aGUgdXBkYXRlIHRvIGFsbCBvYmplY3RzIHRoYXQgbWF0Y2ggdGhlIGdpdmVuIFBhcnNlIFF1ZXJ5LlxuICB1cGRhdGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCB1cGRhdGU6IGFueSk6IFByb21pc2U8W2FueV0+IHtcbiAgICBkZWJ1ZygndXBkYXRlT2JqZWN0c0J5UXVlcnknLCBjbGFzc05hbWUsIHF1ZXJ5LCB1cGRhdGUpO1xuICAgIGNvbnN0IHVwZGF0ZVBhdHRlcm5zID0gW107XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZV1cbiAgICBsZXQgaW5kZXggPSAyO1xuICAgIHNjaGVtYSA9IHRvUG9zdGdyZXNTY2hlbWEoc2NoZW1hKTtcblxuICAgIGNvbnN0IG9yaWdpbmFsVXBkYXRlID0gey4uLnVwZGF0ZX07XG4gICAgdXBkYXRlID0gaGFuZGxlRG90RmllbGRzKHVwZGF0ZSk7XG4gICAgLy8gUmVzb2x2ZSBhdXRoRGF0YSBmaXJzdCxcbiAgICAvLyBTbyB3ZSBkb24ndCBlbmQgdXAgd2l0aCBtdWx0aXBsZSBrZXkgdXBkYXRlc1xuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIHVwZGF0ZSkge1xuICAgICAgY29uc3QgYXV0aERhdGFNYXRjaCA9IGZpZWxkTmFtZS5tYXRjaCgvXl9hdXRoX2RhdGFfKFthLXpBLVowLTlfXSspJC8pO1xuICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgdmFyIHByb3ZpZGVyID0gYXV0aERhdGFNYXRjaFsxXTtcbiAgICAgICAgY29uc3QgdmFsdWUgPSB1cGRhdGVbZmllbGROYW1lXTtcbiAgICAgICAgZGVsZXRlIHVwZGF0ZVtmaWVsZE5hbWVdO1xuICAgICAgICB1cGRhdGVbJ2F1dGhEYXRhJ10gPSB1cGRhdGVbJ2F1dGhEYXRhJ10gfHwge307XG4gICAgICAgIHVwZGF0ZVsnYXV0aERhdGEnXVtwcm92aWRlcl0gPSB2YWx1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiB1cGRhdGUpIHtcbiAgICAgIGNvbnN0IGZpZWxkVmFsdWUgPSB1cGRhdGVbZmllbGROYW1lXTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gTlVMTGApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICBpbmRleCArPSAxO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT0gJ2F1dGhEYXRhJykge1xuICAgICAgICAvLyBUaGlzIHJlY3Vyc2l2ZWx5IHNldHMgdGhlIGpzb25fb2JqZWN0XG4gICAgICAgIC8vIE9ubHkgMSBsZXZlbCBkZWVwXG4gICAgICAgIGNvbnN0IGdlbmVyYXRlID0gKGpzb25iOiBzdHJpbmcsIGtleTogc3RyaW5nLCB2YWx1ZTogYW55KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIGBqc29uX29iamVjdF9zZXRfa2V5KENPQUxFU0NFKCR7anNvbmJ9LCAne30nOjpqc29uYiksICR7a2V5fSwgJHt2YWx1ZX0pOjpqc29uYmA7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbGFzdEtleSA9IGAkJHtpbmRleH06bmFtZWA7XG4gICAgICAgIGNvbnN0IGZpZWxkTmFtZUluZGV4ID0gaW5kZXg7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGNvbnN0IHVwZGF0ZSA9IE9iamVjdC5rZXlzKGZpZWxkVmFsdWUpLnJlZHVjZSgobGFzdEtleTogc3RyaW5nLCBrZXk6IHN0cmluZykgPT4ge1xuICAgICAgICAgIGNvbnN0IHN0ciA9IGdlbmVyYXRlKGxhc3RLZXksIGAkJHtpbmRleH06OnRleHRgLCBgJCR7aW5kZXggKyAxfTo6anNvbmJgKVxuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgbGV0IHZhbHVlID0gZmllbGRWYWx1ZVtrZXldO1xuICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIHZhbHVlcy5wdXNoKGtleSwgdmFsdWUpO1xuICAgICAgICAgIHJldHVybiBzdHI7XG4gICAgICAgIH0sIGxhc3RLZXkpO1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtmaWVsZE5hbWVJbmRleH06bmFtZSA9ICR7dXBkYXRlfWApO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdJbmNyZW1lbnQnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsIDApICsgJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUuYW1vdW50KTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnQWRkJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9IGFycmF5X2FkZChDT0FMRVNDRSgkJHtpbmRleH06bmFtZSwgJ1tdJzo6anNvbmIpLCAkJHtpbmRleCArIDF9Ojpqc29uYilgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnRGVsZXRlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKVxuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIG51bGwpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdSZW1vdmUnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gYXJyYXlfcmVtb3ZlKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICsgMX06Ompzb25iKWApXG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZS5vYmplY3RzKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ0FkZFVuaXF1ZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBhcnJheV9hZGRfdW5pcXVlKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICsgMX06Ompzb25iKWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUub2JqZWN0cykpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT09ICd1cGRhdGVkQXQnKSB7IC8vVE9ETzogc3RvcCBzcGVjaWFsIGNhc2luZyB0aGlzLiBJdCBzaG91bGQgY2hlY2sgZm9yIF9fdHlwZSA9PT0gJ0RhdGUnIGFuZCB1c2UgLmlzb1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKVxuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnUG9pbnRlcicpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5vYmplY3RJZCk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnRGF0ZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdG9Qb3N0Z3Jlc1ZhbHVlKGZpZWxkVmFsdWUpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZSBpbnN0YW5jZW9mIERhdGUpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnRmlsZScpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdG9Qb3N0Z3Jlc1ZhbHVlKGZpZWxkVmFsdWUpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBQT0lOVCgkJHtpbmRleCArIDF9LCAkJHtpbmRleCArIDJ9KWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUubG9uZ2l0dWRlLCBmaWVsZFZhbHVlLmxhdGl0dWRlKTtcbiAgICAgICAgaW5kZXggKz0gMztcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2x5Z29uJykge1xuICAgICAgICBjb25zdCB2YWx1ZSA9IGNvbnZlcnRQb2x5Z29uVG9TUUwoZmllbGRWYWx1ZS5jb29yZGluYXRlcyk7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfTo6cG9seWdvbmApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIHZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgLy8gbm9vcFxuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnb2JqZWN0J1xuICAgICAgICAgICAgICAgICAgICAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV1cbiAgICAgICAgICAgICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdPYmplY3QnKSB7XG4gICAgICAgIC8vIEdhdGhlciBrZXlzIHRvIGluY3JlbWVudFxuICAgICAgICBjb25zdCBrZXlzVG9JbmNyZW1lbnQgPSBPYmplY3Qua2V5cyhvcmlnaW5hbFVwZGF0ZSkuZmlsdGVyKGsgPT4ge1xuICAgICAgICAgIC8vIGNob29zZSB0b3AgbGV2ZWwgZmllbGRzIHRoYXQgaGF2ZSBhIGRlbGV0ZSBvcGVyYXRpb24gc2V0XG4gICAgICAgICAgLy8gTm90ZSB0aGF0IE9iamVjdC5rZXlzIGlzIGl0ZXJhdGluZyBvdmVyIHRoZSAqKm9yaWdpbmFsKiogdXBkYXRlIG9iamVjdFxuICAgICAgICAgIC8vIGFuZCB0aGF0IHNvbWUgb2YgdGhlIGtleXMgb2YgdGhlIG9yaWdpbmFsIHVwZGF0ZSBjb3VsZCBiZSBudWxsIG9yIHVuZGVmaW5lZDpcbiAgICAgICAgICAvLyAoU2VlIHRoZSBhYm92ZSBjaGVjayBgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgdHlwZW9mIGZpZWxkVmFsdWUgPT0gXCJ1bmRlZmluZWRcIilgKVxuICAgICAgICAgIGNvbnN0IHZhbHVlID0gb3JpZ2luYWxVcGRhdGVba107XG4gICAgICAgICAgcmV0dXJuIHZhbHVlICYmIHZhbHVlLl9fb3AgPT09ICdJbmNyZW1lbnQnICYmIGsuc3BsaXQoJy4nKS5sZW5ndGggPT09IDIgJiYgay5zcGxpdChcIi5cIilbMF0gPT09IGZpZWxkTmFtZTtcbiAgICAgICAgfSkubWFwKGsgPT4gay5zcGxpdCgnLicpWzFdKTtcblxuICAgICAgICBsZXQgaW5jcmVtZW50UGF0dGVybnMgPSAnJztcbiAgICAgICAgaWYgKGtleXNUb0luY3JlbWVudC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgaW5jcmVtZW50UGF0dGVybnMgPSAnIHx8ICcgKyBrZXlzVG9JbmNyZW1lbnQubWFwKChjKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBhbW91bnQgPSBmaWVsZFZhbHVlW2NdLmFtb3VudDtcbiAgICAgICAgICAgIHJldHVybiBgQ09OQ0FUKCd7XCIke2N9XCI6JywgQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUtPj4nJHtjfScsJzAnKTo6aW50ICsgJHthbW91bnR9LCAnfScpOjpqc29uYmA7XG4gICAgICAgICAgfSkuam9pbignIHx8ICcpO1xuICAgICAgICAgIC8vIFN0cmlwIHRoZSBrZXlzXG4gICAgICAgICAga2V5c1RvSW5jcmVtZW50LmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICAgICAgZGVsZXRlIGZpZWxkVmFsdWVba2V5XTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGtleXNUb0RlbGV0ZTogQXJyYXk8c3RyaW5nPiA9IE9iamVjdC5rZXlzKG9yaWdpbmFsVXBkYXRlKS5maWx0ZXIoayA9PiB7XG4gICAgICAgICAgLy8gY2hvb3NlIHRvcCBsZXZlbCBmaWVsZHMgdGhhdCBoYXZlIGEgZGVsZXRlIG9wZXJhdGlvbiBzZXQuXG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBvcmlnaW5hbFVwZGF0ZVtrXTtcbiAgICAgICAgICByZXR1cm4gdmFsdWUgJiYgdmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScgJiYgay5zcGxpdCgnLicpLmxlbmd0aCA9PT0gMiAmJiBrLnNwbGl0KFwiLlwiKVswXSA9PT0gZmllbGROYW1lO1xuICAgICAgICB9KS5tYXAoayA9PiBrLnNwbGl0KCcuJylbMV0pO1xuXG4gICAgICAgIGNvbnN0IGRlbGV0ZVBhdHRlcm5zID0ga2V5c1RvRGVsZXRlLnJlZHVjZSgocDogc3RyaW5nLCBjOiBzdHJpbmcsIGk6IG51bWJlcikgPT4ge1xuICAgICAgICAgIHJldHVybiBwICsgYCAtICckJHtpbmRleCArIDEgKyBpfTp2YWx1ZSdgO1xuICAgICAgICB9LCAnJyk7XG5cbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAoJ3t9Jzo6anNvbmIgJHtkZWxldGVQYXR0ZXJuc30gJHtpbmNyZW1lbnRQYXR0ZXJuc30gfHwgJCR7aW5kZXggKyAxICsga2V5c1RvRGVsZXRlLmxlbmd0aH06Ompzb25iIClgKTtcblxuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIC4uLmtleXNUb0RlbGV0ZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyICsga2V5c1RvRGVsZXRlLmxlbmd0aDtcbiAgICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlKVxuICAgICAgICAgICAgICAgICAgICAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV1cbiAgICAgICAgICAgICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheScpIHtcbiAgICAgICAgY29uc3QgZXhwZWN0ZWRUeXBlID0gcGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUoc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdKTtcbiAgICAgICAgaWYgKGV4cGVjdGVkVHlwZSA9PT0gJ3RleHRbXScpIHtcbiAgICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX06OnRleHRbXWApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGxldCB0eXBlID0gJ3RleHQnO1xuICAgICAgICAgIGZvciAoY29uc3QgZWx0IG9mIGZpZWxkVmFsdWUpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgZWx0ID09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICAgIHR5cGUgPSAnanNvbic7XG4gICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9IGFycmF5X3RvX2pzb24oJCR7aW5kZXggKyAxfTo6JHt0eXBlfVtdKTo6anNvbmJgKTtcbiAgICAgICAgfVxuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgZGVidWcoJ05vdCBzdXBwb3J0ZWQgdXBkYXRlJywgZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5PUEVSQVRJT05fRk9SQklEREVOLCBgUG9zdGdyZXMgZG9lc24ndCBzdXBwb3J0IHVwZGF0ZSAke0pTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUpfSB5ZXRgKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgd2hlcmUgPSBidWlsZFdoZXJlQ2xhdXNlKHsgc2NoZW1hLCBpbmRleCwgcXVlcnkgfSlcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVDbGF1c2UgPSB3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHt3aGVyZS5wYXR0ZXJufWAgOiAnJztcbiAgICBjb25zdCBxcyA9IGBVUERBVEUgJDE6bmFtZSBTRVQgJHt1cGRhdGVQYXR0ZXJucy5qb2luKCl9ICR7d2hlcmVDbGF1c2V9IFJFVFVSTklORyAqYDtcbiAgICBkZWJ1ZygndXBkYXRlOiAnLCBxcywgdmFsdWVzKTtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50LmFueShxcywgdmFsdWVzKTtcbiAgfVxuXG4gIC8vIEhvcGVmdWxseSwgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCB1cGRhdGU6IGFueSkge1xuICAgIGRlYnVnKCd1cHNlcnRPbmVPYmplY3QnLCB7Y2xhc3NOYW1lLCBxdWVyeSwgdXBkYXRlfSk7XG4gICAgY29uc3QgY3JlYXRlVmFsdWUgPSBPYmplY3QuYXNzaWduKHt9LCBxdWVyeSwgdXBkYXRlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVPYmplY3QoY2xhc3NOYW1lLCBzY2hlbWEsIGNyZWF0ZVZhbHVlKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgLy8gaWdub3JlIGR1cGxpY2F0ZSB2YWx1ZSBlcnJvcnMgYXMgaXQncyB1cHNlcnRcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0aGlzLmZpbmRPbmVBbmRVcGRhdGUoY2xhc3NOYW1lLCBzY2hlbWEsIHF1ZXJ5LCB1cGRhdGUpO1xuICAgICAgfSk7XG4gIH1cblxuICBmaW5kKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUsIHsgc2tpcCwgbGltaXQsIHNvcnQsIGtleXMgfTogUXVlcnlPcHRpb25zKSB7XG4gICAgZGVidWcoJ2ZpbmQnLCBjbGFzc05hbWUsIHF1ZXJ5LCB7c2tpcCwgbGltaXQsIHNvcnQsIGtleXMgfSk7XG4gICAgY29uc3QgaGFzTGltaXQgPSBsaW1pdCAhPT0gdW5kZWZpbmVkO1xuICAgIGNvbnN0IGhhc1NraXAgPSBza2lwICE9PSB1bmRlZmluZWQ7XG4gICAgbGV0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7IHNjaGVtYSwgcXVlcnksIGluZGV4OiAyIH0pXG4gICAgdmFsdWVzLnB1c2goLi4ud2hlcmUudmFsdWVzKTtcblxuICAgIGNvbnN0IHdoZXJlUGF0dGVybiA9IHdoZXJlLnBhdHRlcm4ubGVuZ3RoID4gMCA/IGBXSEVSRSAke3doZXJlLnBhdHRlcm59YCA6ICcnO1xuICAgIGNvbnN0IGxpbWl0UGF0dGVybiA9IGhhc0xpbWl0ID8gYExJTUlUICQke3ZhbHVlcy5sZW5ndGggKyAxfWAgOiAnJztcbiAgICBpZiAoaGFzTGltaXQpIHtcbiAgICAgIHZhbHVlcy5wdXNoKGxpbWl0KTtcbiAgICB9XG4gICAgY29uc3Qgc2tpcFBhdHRlcm4gPSBoYXNTa2lwID8gYE9GRlNFVCAkJHt2YWx1ZXMubGVuZ3RoICsgMX1gIDogJyc7XG4gICAgaWYgKGhhc1NraXApIHtcbiAgICAgIHZhbHVlcy5wdXNoKHNraXApO1xuICAgIH1cblxuICAgIGxldCBzb3J0UGF0dGVybiA9ICcnO1xuICAgIGlmIChzb3J0KSB7XG4gICAgICBjb25zdCBzb3J0Q29weTogYW55ID0gc29ydDtcbiAgICAgIGNvbnN0IHNvcnRpbmcgPSBPYmplY3Qua2V5cyhzb3J0KS5tYXAoKGtleSkgPT4ge1xuICAgICAgICBjb25zdCB0cmFuc2Zvcm1LZXkgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhrZXkpLmpvaW4oJy0+Jyk7XG4gICAgICAgIC8vIFVzaW5nICRpZHggcGF0dGVybiBnaXZlczogIG5vbi1pbnRlZ2VyIGNvbnN0YW50IGluIE9SREVSIEJZXG4gICAgICAgIGlmIChzb3J0Q29weVtrZXldID09PSAxKSB7XG4gICAgICAgICAgcmV0dXJuIGAke3RyYW5zZm9ybUtleX0gQVNDYDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gYCR7dHJhbnNmb3JtS2V5fSBERVNDYDtcbiAgICAgIH0pLmpvaW4oKTtcbiAgICAgIHNvcnRQYXR0ZXJuID0gc29ydCAhPT0gdW5kZWZpbmVkICYmIE9iamVjdC5rZXlzKHNvcnQpLmxlbmd0aCA+IDAgPyBgT1JERVIgQlkgJHtzb3J0aW5nfWAgOiAnJztcbiAgICB9XG4gICAgaWYgKHdoZXJlLnNvcnRzICYmIE9iamVjdC5rZXlzKCh3aGVyZS5zb3J0czogYW55KSkubGVuZ3RoID4gMCkge1xuICAgICAgc29ydFBhdHRlcm4gPSBgT1JERVIgQlkgJHt3aGVyZS5zb3J0cy5qb2luKCl9YDtcbiAgICB9XG5cbiAgICBsZXQgY29sdW1ucyA9ICcqJztcbiAgICBpZiAoa2V5cykge1xuICAgICAgLy8gRXhjbHVkZSBlbXB0eSBrZXlzXG4gICAgICAvLyBSZXBsYWNlIEFDTCBieSBpdCdzIGtleXNcbiAgICAgIGtleXMgPSBrZXlzLnJlZHVjZSgobWVtbywga2V5KSA9PiB7XG4gICAgICAgIGlmIChrZXkgPT09ICdBQ0wnKSB7XG4gICAgICAgICAgbWVtby5wdXNoKCdfcnBlcm0nKTtcbiAgICAgICAgICBtZW1vLnB1c2goJ193cGVybScpO1xuICAgICAgICB9IGVsc2UgaWYgKGtleS5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgbWVtby5wdXNoKGtleSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG1lbW87XG4gICAgICB9LCBbXSk7XG4gICAgICBjb2x1bW5zID0ga2V5cy5tYXAoKGtleSwgaW5kZXgpID0+IHtcbiAgICAgICAgaWYgKGtleSA9PT0gJyRzY29yZScpIHtcbiAgICAgICAgICByZXR1cm4gYHRzX3JhbmtfY2QodG9fdHN2ZWN0b3IoJCR7Mn0sICQkezN9Om5hbWUpLCB0b190c3F1ZXJ5KCQkezR9LCAkJHs1fSksIDMyKSBhcyBzY29yZWA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGAkJHtpbmRleCArIHZhbHVlcy5sZW5ndGggKyAxfTpuYW1lYDtcbiAgICAgIH0pLmpvaW4oKTtcbiAgICAgIHZhbHVlcyA9IHZhbHVlcy5jb25jYXQoa2V5cyk7XG4gICAgfVxuXG4gICAgY29uc3QgcXMgPSBgU0VMRUNUICR7Y29sdW1uc30gRlJPTSAkMTpuYW1lICR7d2hlcmVQYXR0ZXJufSAke3NvcnRQYXR0ZXJufSAke2xpbWl0UGF0dGVybn0gJHtza2lwUGF0dGVybn1gO1xuICAgIGRlYnVnKHFzLCB2YWx1ZXMpO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQuYW55KHFzLCB2YWx1ZXMpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvLyBRdWVyeSBvbiBub24gZXhpc3RpbmcgdGFibGUsIGRvbid0IGNyYXNoXG4gICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiByZXN1bHRzLm1hcChvYmplY3QgPT4gdGhpcy5wb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lLCBvYmplY3QsIHNjaGVtYSkpKTtcbiAgfVxuXG4gIC8vIENvbnZlcnRzIGZyb20gYSBwb3N0Z3Jlcy1mb3JtYXQgb2JqZWN0IHRvIGEgUkVTVC1mb3JtYXQgb2JqZWN0LlxuICAvLyBEb2VzIG5vdCBzdHJpcCBvdXQgYW55dGhpbmcgYmFzZWQgb24gYSBsYWNrIG9mIGF1dGhlbnRpY2F0aW9uLlxuICBwb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIG9iamVjdDogYW55LCBzY2hlbWE6IGFueSkge1xuICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInICYmIG9iamVjdFtmaWVsZE5hbWVdKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0geyBvYmplY3RJZDogb2JqZWN0W2ZpZWxkTmFtZV0sIF9fdHlwZTogJ1BvaW50ZXInLCBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyB9O1xuICAgICAgfVxuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogXCJSZWxhdGlvblwiLFxuICAgICAgICAgIGNsYXNzTmFtZTogc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnRhcmdldENsYXNzXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0dlb1BvaW50Jykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6IFwiR2VvUG9pbnRcIixcbiAgICAgICAgICBsYXRpdHVkZTogb2JqZWN0W2ZpZWxkTmFtZV0ueSxcbiAgICAgICAgICBsb25naXR1ZGU6IG9iamVjdFtmaWVsZE5hbWVdLnhcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgbGV0IGNvb3JkcyA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBjb29yZHMgPSBjb29yZHMuc3Vic3RyKDIsIGNvb3Jkcy5sZW5ndGggLSA0KS5zcGxpdCgnKSwoJyk7XG4gICAgICAgIGNvb3JkcyA9IGNvb3Jkcy5tYXAoKHBvaW50KSA9PiB7XG4gICAgICAgICAgcmV0dXJuIFtcbiAgICAgICAgICAgIHBhcnNlRmxvYXQocG9pbnQuc3BsaXQoJywnKVsxXSksXG4gICAgICAgICAgICBwYXJzZUZsb2F0KHBvaW50LnNwbGl0KCcsJylbMF0pXG4gICAgICAgICAgXTtcbiAgICAgICAgfSk7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogXCJQb2x5Z29uXCIsXG4gICAgICAgICAgY29vcmRpbmF0ZXM6IGNvb3Jkc1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdGaWxlJykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdGaWxlJyxcbiAgICAgICAgICBuYW1lOiBvYmplY3RbZmllbGROYW1lXVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9UT0RPOiByZW1vdmUgdGhpcyByZWxpYW5jZSBvbiB0aGUgbW9uZ28gZm9ybWF0LiBEQiBhZGFwdGVyIHNob3VsZG4ndCBrbm93IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIGNyZWF0ZWQgYXQgYW5kIGFueSBvdGhlciBkYXRlIGZpZWxkLlxuICAgIGlmIChvYmplY3QuY3JlYXRlZEF0KSB7XG4gICAgICBvYmplY3QuY3JlYXRlZEF0ID0gb2JqZWN0LmNyZWF0ZWRBdC50b0lTT1N0cmluZygpO1xuICAgIH1cbiAgICBpZiAob2JqZWN0LnVwZGF0ZWRBdCkge1xuICAgICAgb2JqZWN0LnVwZGF0ZWRBdCA9IG9iamVjdC51cGRhdGVkQXQudG9JU09TdHJpbmcoKTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5leHBpcmVzQXQpIHtcbiAgICAgIG9iamVjdC5leHBpcmVzQXQgPSB7IF9fdHlwZTogJ0RhdGUnLCBpc286IG9iamVjdC5leHBpcmVzQXQudG9JU09TdHJpbmcoKSB9O1xuICAgIH1cbiAgICBpZiAob2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCkge1xuICAgICAgb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCA9IHsgX190eXBlOiAnRGF0ZScsIGlzbzogb2JqZWN0Ll9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdC50b0lTT1N0cmluZygpIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0ID0geyBfX3R5cGU6ICdEYXRlJywgaXNvOiBvYmplY3QuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0LnRvSVNPU3RyaW5nKCkgfTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCA9IHsgX190eXBlOiAnRGF0ZScsIGlzbzogb2JqZWN0Ll9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQudG9JU09TdHJpbmcoKSB9O1xuICAgIH1cbiAgICBpZiAob2JqZWN0Ll9wYXNzd29yZF9jaGFuZ2VkX2F0KSB7XG4gICAgICBvYmplY3QuX3Bhc3N3b3JkX2NoYW5nZWRfYXQgPSB7IF9fdHlwZTogJ0RhdGUnLCBpc286IG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdC50b0lTT1N0cmluZygpIH07XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gb2JqZWN0KSB7XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gPT09IG51bGwpIHtcbiAgICAgICAgZGVsZXRlIG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgfVxuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdIGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHsgX190eXBlOiAnRGF0ZScsIGlzbzogb2JqZWN0W2ZpZWxkTmFtZV0udG9JU09TdHJpbmcoKSB9O1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBvYmplY3Q7XG4gIH1cblxuICAvLyBDcmVhdGUgYSB1bmlxdWUgaW5kZXguIFVuaXF1ZSBpbmRleGVzIG9uIG51bGxhYmxlIGZpZWxkcyBhcmUgbm90IGFsbG93ZWQuIFNpbmNlIHdlIGRvbid0XG4gIC8vIGN1cnJlbnRseSBrbm93IHdoaWNoIGZpZWxkcyBhcmUgbnVsbGFibGUgYW5kIHdoaWNoIGFyZW4ndCwgd2UgaWdub3JlIHRoYXQgY3JpdGVyaWEuXG4gIC8vIEFzIHN1Y2gsIHdlIHNob3VsZG4ndCBleHBvc2UgdGhpcyBmdW5jdGlvbiB0byB1c2VycyBvZiBwYXJzZSB1bnRpbCB3ZSBoYXZlIGFuIG91dC1vZi1iYW5kXG4gIC8vIFdheSBvZiBkZXRlcm1pbmluZyBpZiBhIGZpZWxkIGlzIG51bGxhYmxlLiBVbmRlZmluZWQgZG9lc24ndCBjb3VudCBhZ2FpbnN0IHVuaXF1ZW5lc3MsXG4gIC8vIHdoaWNoIGlzIHdoeSB3ZSB1c2Ugc3BhcnNlIGluZGV4ZXMuXG4gIGVuc3VyZVVuaXF1ZW5lc3MoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgZmllbGROYW1lczogc3RyaW5nW10pIHtcbiAgICAvLyBVc2UgdGhlIHNhbWUgbmFtZSBmb3IgZXZlcnkgZW5zdXJlVW5pcXVlbmVzcyBhdHRlbXB0LCBiZWNhdXNlIHBvc3RncmVzXG4gICAgLy8gV2lsbCBoYXBwaWx5IGNyZWF0ZSB0aGUgc2FtZSBpbmRleCB3aXRoIG11bHRpcGxlIG5hbWVzLlxuICAgIGNvbnN0IGNvbnN0cmFpbnROYW1lID0gYHVuaXF1ZV8ke2ZpZWxkTmFtZXMuc29ydCgpLmpvaW4oJ18nKX1gO1xuICAgIGNvbnN0IGNvbnN0cmFpbnRQYXR0ZXJucyA9IGZpZWxkTmFtZXMubWFwKChmaWVsZE5hbWUsIGluZGV4KSA9PiBgJCR7aW5kZXggKyAzfTpuYW1lYCk7XG4gICAgY29uc3QgcXMgPSBgQUxURVIgVEFCTEUgJDE6bmFtZSBBREQgQ09OU1RSQUlOVCAkMjpuYW1lIFVOSVFVRSAoJHtjb25zdHJhaW50UGF0dGVybnMuam9pbigpfSlgO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQubm9uZShxcywgW2NsYXNzTmFtZSwgY29uc3RyYWludE5hbWUsIC4uLmZpZWxkTmFtZXNdKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciAmJiBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGNvbnN0cmFpbnROYW1lKSkge1xuICAgICAgICAvLyBJbmRleCBhbHJlYWR5IGV4aXN0cy4gSWdub3JlIGVycm9yLlxuICAgICAgICB9IGVsc2UgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciAmJiBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGNvbnN0cmFpbnROYW1lKSkge1xuICAgICAgICAvLyBDYXN0IHRoZSBlcnJvciBpbnRvIHRoZSBwcm9wZXIgcGFyc2UgZXJyb3JcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLCAnQSBkdXBsaWNhdGUgdmFsdWUgZm9yIGEgZmllbGQgd2l0aCB1bmlxdWUgdmFsdWVzIHdhcyBwcm92aWRlZCcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIEV4ZWN1dGVzIGEgY291bnQuXG4gIGNvdW50KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUpIHtcbiAgICBkZWJ1ZygnY291bnQnLCBjbGFzc05hbWUsIHF1ZXJ5KTtcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lXTtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIHF1ZXJ5LCBpbmRleDogMiB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID0gd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgY29uc3QgcXMgPSBgU0VMRUNUIGNvdW50KCopIEZST00gJDE6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQub25lKHFzLCB2YWx1ZXMsIGEgPT4gK2EuY291bnQpXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIDA7XG4gICAgICB9KTtcbiAgfVxuXG4gIGRpc3RpbmN0KGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIHF1ZXJ5OiBRdWVyeVR5cGUsIGZpZWxkTmFtZTogc3RyaW5nKSB7XG4gICAgZGVidWcoJ2Rpc3RpbmN0JywgY2xhc3NOYW1lLCBxdWVyeSk7XG4gICAgbGV0IGZpZWxkID0gZmllbGROYW1lO1xuICAgIGxldCBjb2x1bW4gPSBmaWVsZE5hbWU7XG4gICAgY29uc3QgaXNOZXN0ZWQgPSBmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDA7XG4gICAgaWYgKGlzTmVzdGVkKSB7XG4gICAgICBmaWVsZCA9IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzKGZpZWxkTmFtZSkuam9pbignLT4nKTtcbiAgICAgIGNvbHVtbiA9IGZpZWxkTmFtZS5zcGxpdCgnLicpWzBdO1xuICAgIH1cbiAgICBjb25zdCBpc0FycmF5RmllbGQgPSBzY2hlbWEuZmllbGRzXG4gICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdXG4gICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSc7XG4gICAgY29uc3QgaXNQb2ludGVyRmllbGQgPSBzY2hlbWEuZmllbGRzXG4gICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdXG4gICAgICAgICAgJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdQb2ludGVyJztcbiAgICBjb25zdCB2YWx1ZXMgPSBbZmllbGQsIGNvbHVtbiwgY2xhc3NOYW1lXTtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2UoeyBzY2hlbWEsIHF1ZXJ5LCBpbmRleDogNCB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID0gd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgY29uc3QgdHJhbnNmb3JtZXIgPSBpc0FycmF5RmllbGQgPyAnanNvbmJfYXJyYXlfZWxlbWVudHMnIDogJ09OJztcbiAgICBsZXQgcXMgPSBgU0VMRUNUIERJU1RJTkNUICR7dHJhbnNmb3JtZXJ9KCQxOm5hbWUpICQyOm5hbWUgRlJPTSAkMzpuYW1lICR7d2hlcmVQYXR0ZXJufWA7XG4gICAgaWYgKGlzTmVzdGVkKSB7XG4gICAgICBxcyA9IGBTRUxFQ1QgRElTVElOQ1QgJHt0cmFuc2Zvcm1lcn0oJDE6cmF3KSAkMjpyYXcgRlJPTSAkMzpuYW1lICR7d2hlcmVQYXR0ZXJufWA7XG4gICAgfVxuICAgIGRlYnVnKHFzLCB2YWx1ZXMpO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQuYW55KHFzLCB2YWx1ZXMpXG4gICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQb3N0Z3Jlc01pc3NpbmdDb2x1bW5FcnJvcikge1xuICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAudGhlbigocmVzdWx0cykgPT4ge1xuICAgICAgICBpZiAoIWlzTmVzdGVkKSB7XG4gICAgICAgICAgcmVzdWx0cyA9IHJlc3VsdHMuZmlsdGVyKChvYmplY3QpID0+IG9iamVjdFtmaWVsZF0gIT09IG51bGwpO1xuICAgICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4ge1xuICAgICAgICAgICAgaWYgKCFpc1BvaW50ZXJGaWVsZCkge1xuICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0W2ZpZWxkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgIF9fdHlwZTogJ1BvaW50ZXInLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udGFyZ2V0Q2xhc3MsXG4gICAgICAgICAgICAgIG9iamVjdElkOiBvYmplY3RbZmllbGRdXG4gICAgICAgICAgICB9O1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNoaWxkID0gZmllbGROYW1lLnNwbGl0KCcuJylbMV07XG4gICAgICAgIHJldHVybiByZXN1bHRzLm1hcChvYmplY3QgPT4gb2JqZWN0W2NvbHVtbl1bY2hpbGRdKTtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXN1bHRzID0+IHJlc3VsdHMubWFwKG9iamVjdCA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSkpO1xuICB9XG5cbiAgYWdncmVnYXRlKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IGFueSwgcGlwZWxpbmU6IGFueSkge1xuICAgIGRlYnVnKCdhZ2dyZWdhdGUnLCBjbGFzc05hbWUsIHBpcGVsaW5lKTtcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lXTtcbiAgICBsZXQgaW5kZXg6IG51bWJlciA9IDI7XG4gICAgbGV0IGNvbHVtbnM6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IGNvdW50RmllbGQgPSBudWxsO1xuICAgIGxldCBncm91cFZhbHVlcyA9IG51bGw7XG4gICAgbGV0IHdoZXJlUGF0dGVybiA9ICcnO1xuICAgIGxldCBsaW1pdFBhdHRlcm4gPSAnJztcbiAgICBsZXQgc2tpcFBhdHRlcm4gPSAnJztcbiAgICBsZXQgc29ydFBhdHRlcm4gPSAnJztcbiAgICBsZXQgZ3JvdXBQYXR0ZXJuID0gJyc7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwaXBlbGluZS5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgY29uc3Qgc3RhZ2UgPSBwaXBlbGluZVtpXTtcbiAgICAgIGlmIChzdGFnZS4kZ3JvdXApIHtcbiAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzdGFnZS4kZ3JvdXApIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IHN0YWdlLiRncm91cFtmaWVsZF07XG4gICAgICAgICAgaWYgKHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZmllbGQgPT09ICdfaWQnICYmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSAmJiB2YWx1ZSAhPT0gJycpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgJCR7aW5kZXh9Om5hbWUgQVMgXCJvYmplY3RJZFwiYCk7XG4gICAgICAgICAgICBncm91cFBhdHRlcm4gPSBgR1JPVVAgQlkgJCR7aW5kZXh9Om5hbWVgO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUpKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZpZWxkID09PSAnX2lkJyAmJiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JykgJiYgT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aCAhPT0gMCkge1xuICAgICAgICAgICAgZ3JvdXBWYWx1ZXMgPSB2YWx1ZTtcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwQnlGaWVsZHMgPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgYWxpYXMgaW4gdmFsdWUpIHtcbiAgICAgICAgICAgICAgY29uc3Qgb3BlcmF0aW9uID0gT2JqZWN0LmtleXModmFsdWVbYWxpYXNdKVswXTtcbiAgICAgICAgICAgICAgY29uc3Qgc291cmNlID0gdHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWVbYWxpYXNdW29wZXJhdGlvbl0pO1xuICAgICAgICAgICAgICBpZiAobW9uZ29BZ2dyZWdhdGVUb1Bvc3RncmVzW29wZXJhdGlvbl0pIHtcbiAgICAgICAgICAgICAgICBpZiAoIWdyb3VwQnlGaWVsZHMuaW5jbHVkZXMoYFwiJHtzb3VyY2V9XCJgKSkge1xuICAgICAgICAgICAgICAgICAgZ3JvdXBCeUZpZWxkcy5wdXNoKGBcIiR7c291cmNlfVwiYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgRVhUUkFDVCgke21vbmdvQWdncmVnYXRlVG9Qb3N0Z3Jlc1tvcGVyYXRpb25dfSBGUk9NICQke2luZGV4fTpuYW1lIEFUIFRJTUUgWk9ORSAnVVRDJykgQVMgJCR7aW5kZXggKyAxfTpuYW1lYCk7XG4gICAgICAgICAgICAgICAgdmFsdWVzLnB1c2goc291cmNlLCBhbGlhcyk7XG4gICAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZ3JvdXBQYXR0ZXJuID0gYEdST1VQIEJZICQke2luZGV4fTpyYXdgO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZ3JvdXBCeUZpZWxkcy5qb2luKCkpO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsdWUuJHN1bSkge1xuICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZS4kc3VtID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goYFNVTSgkJHtpbmRleH06bmFtZSkgQVMgJCR7aW5kZXggKyAxfTpuYW1lYCk7XG4gICAgICAgICAgICAgIHZhbHVlcy5wdXNoKHRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkKHZhbHVlLiRzdW0pLCBmaWVsZCk7XG4gICAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBjb3VudEZpZWxkID0gZmllbGQ7XG4gICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgQ09VTlQoKikgQVMgJCR7aW5kZXh9Om5hbWVgKTtcbiAgICAgICAgICAgICAgdmFsdWVzLnB1c2goZmllbGQpO1xuICAgICAgICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodmFsdWUuJG1heCkge1xuICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBNQVgoJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2godHJhbnNmb3JtQWdncmVnYXRlRmllbGQodmFsdWUuJG1heCksIGZpZWxkKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh2YWx1ZS4kbWluKSB7XG4gICAgICAgICAgICBjb2x1bW5zLnB1c2goYE1JTigkJHtpbmRleH06bmFtZSkgQVMgJCR7aW5kZXggKyAxfTpuYW1lYCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kbWluKSwgZmllbGQpO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHZhbHVlLiRhdmcpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgQVZHKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKHRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkKHZhbHVlLiRhdmcpLCBmaWVsZCk7XG4gICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29sdW1ucy5wdXNoKCcqJyk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHByb2plY3QpIHtcbiAgICAgICAgaWYgKGNvbHVtbnMuaW5jbHVkZXMoJyonKSkge1xuICAgICAgICAgIGNvbHVtbnMgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBzdGFnZS4kcHJvamVjdFtmaWVsZF07XG4gICAgICAgICAgaWYgKCh2YWx1ZSA9PT0gMSB8fCB2YWx1ZSA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgIGNvbHVtbnMucHVzaChgJCR7aW5kZXh9Om5hbWVgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkKTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJG1hdGNoKSB7XG4gICAgICAgIGNvbnN0IHBhdHRlcm5zID0gW107XG4gICAgICAgIGNvbnN0IG9yT3JBbmQgPSBzdGFnZS4kbWF0Y2guaGFzT3duUHJvcGVydHkoJyRvcicpID8gJyBPUiAnIDogJyBBTkQgJztcblxuICAgICAgICBpZiAoc3RhZ2UuJG1hdGNoLiRvcikge1xuICAgICAgICAgIGNvbnN0IGNvbGxhcHNlID0ge307XG4gICAgICAgICAgc3RhZ2UuJG1hdGNoLiRvci5mb3JFYWNoKChlbGVtZW50KSA9PiB7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBpbiBlbGVtZW50KSB7XG4gICAgICAgICAgICAgIGNvbGxhcHNlW2tleV0gPSBlbGVtZW50W2tleV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgc3RhZ2UuJG1hdGNoID0gY29sbGFwc2U7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBmaWVsZCBpbiBzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IHN0YWdlLiRtYXRjaFtmaWVsZF07XG4gICAgICAgICAgY29uc3QgbWF0Y2hQYXR0ZXJucyA9IFtdO1xuICAgICAgICAgIE9iamVjdC5rZXlzKFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcikuZm9yRWFjaCgoY21wKSA9PiB7XG4gICAgICAgICAgICBpZiAodmFsdWVbY21wXSkge1xuICAgICAgICAgICAgICBjb25zdCBwZ0NvbXBhcmF0b3IgPSBQYXJzZVRvUG9zZ3Jlc0NvbXBhcmF0b3JbY21wXTtcbiAgICAgICAgICAgICAgbWF0Y2hQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSAke3BnQ29tcGFyYXRvcn0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCwgdG9Qb3N0Z3Jlc1ZhbHVlKHZhbHVlW2NtcF0pKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAobWF0Y2hQYXR0ZXJucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAoJHttYXRjaFBhdHRlcm5zLmpvaW4oJyBBTkQgJyl9KWApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJiBtYXRjaFBhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCwgdmFsdWUpO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgd2hlcmVQYXR0ZXJuID0gcGF0dGVybnMubGVuZ3RoID4gMCA/IGBXSEVSRSAke3BhdHRlcm5zLmpvaW4oYCAke29yT3JBbmR9IGApfWAgOiAnJztcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kbGltaXQpIHtcbiAgICAgICAgbGltaXRQYXR0ZXJuID0gYExJTUlUICQke2luZGV4fWA7XG4gICAgICAgIHZhbHVlcy5wdXNoKHN0YWdlLiRsaW1pdCk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHNraXApIHtcbiAgICAgICAgc2tpcFBhdHRlcm4gPSBgT0ZGU0VUICQke2luZGV4fWA7XG4gICAgICAgIHZhbHVlcy5wdXNoKHN0YWdlLiRza2lwKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kc29ydCkge1xuICAgICAgICBjb25zdCBzb3J0ID0gc3RhZ2UuJHNvcnQ7XG4gICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhzb3J0KTtcbiAgICAgICAgY29uc3Qgc29ydGluZyA9IGtleXMubWFwKChrZXkpID0+IHtcbiAgICAgICAgICBjb25zdCB0cmFuc2Zvcm1lciA9IHNvcnRba2V5XSA9PT0gMSA/ICdBU0MnIDogJ0RFU0MnO1xuICAgICAgICAgIGNvbnN0IG9yZGVyID0gYCQke2luZGV4fTpuYW1lICR7dHJhbnNmb3JtZXJ9YDtcbiAgICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICAgIHJldHVybiBvcmRlcjtcbiAgICAgICAgfSkuam9pbigpO1xuICAgICAgICB2YWx1ZXMucHVzaCguLi5rZXlzKTtcbiAgICAgICAgc29ydFBhdHRlcm4gPSBzb3J0ICE9PSB1bmRlZmluZWQgJiYgc29ydGluZy5sZW5ndGggPiAwID8gYE9SREVSIEJZICR7c29ydGluZ31gIDogJyc7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgcXMgPSBgU0VMRUNUICR7Y29sdW1ucy5qb2luKCl9IEZST00gJDE6bmFtZSAke3doZXJlUGF0dGVybn0gJHtzb3J0UGF0dGVybn0gJHtsaW1pdFBhdHRlcm59ICR7c2tpcFBhdHRlcm59ICR7Z3JvdXBQYXR0ZXJufWA7XG4gICAgZGVidWcocXMsIHZhbHVlcyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5tYXAocXMsIHZhbHVlcywgYSA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIGEsIHNjaGVtYSkpXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgcmVzdWx0cy5mb3JFYWNoKHJlc3VsdCA9PiB7XG4gICAgICAgICAgaWYgKCFyZXN1bHQuaGFzT3duUHJvcGVydHkoJ29iamVjdElkJykpIHtcbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IG51bGw7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChncm91cFZhbHVlcykge1xuICAgICAgICAgICAgcmVzdWx0Lm9iamVjdElkID0ge307XG4gICAgICAgICAgICBmb3IgKGNvbnN0IGtleSBpbiBncm91cFZhbHVlcykge1xuICAgICAgICAgICAgICByZXN1bHQub2JqZWN0SWRba2V5XSA9IHJlc3VsdFtrZXldO1xuICAgICAgICAgICAgICBkZWxldGUgcmVzdWx0W2tleV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjb3VudEZpZWxkKSB7XG4gICAgICAgICAgICByZXN1bHRbY291bnRGaWVsZF0gPSBwYXJzZUludChyZXN1bHRbY291bnRGaWVsZF0sIDEwKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gcmVzdWx0cztcbiAgICAgIH0pO1xuICB9XG5cbiAgcGVyZm9ybUluaXRpYWxpemF0aW9uKHsgVm9sYXRpbGVDbGFzc2VzU2NoZW1hcyB9OiBhbnkpIHtcbiAgICAvLyBUT0RPOiBUaGlzIG1ldGhvZCBuZWVkcyB0byBiZSByZXdyaXR0ZW4gdG8gbWFrZSBwcm9wZXIgdXNlIG9mIGNvbm5lY3Rpb25zIChAdml0YWx5LXQpXG4gICAgZGVidWcoJ3BlcmZvcm1Jbml0aWFsaXphdGlvbicpO1xuICAgIGNvbnN0IHByb21pc2VzID0gVm9sYXRpbGVDbGFzc2VzU2NoZW1hcy5tYXAoKHNjaGVtYSkgPT4ge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlVGFibGUoc2NoZW1hLmNsYXNzTmFtZSwgc2NoZW1hKVxuICAgICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICAgIGlmIChlcnIuY29kZSA9PT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yIHx8IGVyci5jb2RlID09PSBQYXJzZS5FcnJvci5JTlZBTElEX0NMQVNTX05BTUUpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9KVxuICAgICAgICAudGhlbigoKSA9PiB0aGlzLnNjaGVtYVVwZ3JhZGUoc2NoZW1hLmNsYXNzTmFtZSwgc2NoZW1hKSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIFByb21pc2UuYWxsKHByb21pc2VzKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICByZXR1cm4gdGhpcy5fY2xpZW50LnR4KCdwZXJmb3JtLWluaXRpYWxpemF0aW9uJywgdCA9PiB7XG4gICAgICAgICAgcmV0dXJuIHQuYmF0Y2goW1xuICAgICAgICAgICAgdC5ub25lKHNxbC5taXNjLmpzb25PYmplY3RTZXRLZXlzKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuYWRkKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuYWRkVW5pcXVlKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkucmVtb3ZlKSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuY29udGFpbnNBbGwpLFxuICAgICAgICAgICAgdC5ub25lKHNxbC5hcnJheS5jb250YWluc0FsbFJlZ2V4KSxcbiAgICAgICAgICAgIHQubm9uZShzcWwuYXJyYXkuY29udGFpbnMpXG4gICAgICAgICAgXSk7XG4gICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGRhdGEgPT4ge1xuICAgICAgICBkZWJ1ZyhgaW5pdGlhbGl6YXRpb25Eb25lIGluICR7ZGF0YS5kdXJhdGlvbn1gKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgICAvKiBlc2xpbnQtZGlzYWJsZSBuby1jb25zb2xlICovXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgICAgfSk7XG4gIH1cblxuICBjcmVhdGVJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnksIGNvbm46ID9hbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gKGNvbm4gfHwgdGhpcy5fY2xpZW50KS50eCh0ID0+IHQuYmF0Y2goaW5kZXhlcy5tYXAoaSA9PiB7XG4gICAgICByZXR1cm4gdC5ub25lKCdDUkVBVEUgSU5ERVggJDE6bmFtZSBPTiAkMjpuYW1lICgkMzpuYW1lKScsIFtpLm5hbWUsIGNsYXNzTmFtZSwgaS5rZXldKTtcbiAgICB9KSkpO1xuICB9XG5cbiAgY3JlYXRlSW5kZXhlc0lmTmVlZGVkKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55LCBjb25uOiA/YW55KTogUHJvbWlzZTx2b2lkPiB7XG4gICAgcmV0dXJuIChjb25uIHx8IHRoaXMuX2NsaWVudCkubm9uZSgnQ1JFQVRFIElOREVYICQxOm5hbWUgT04gJDI6bmFtZSAoJDM6bmFtZSknLCBbZmllbGROYW1lLCBjbGFzc05hbWUsIHR5cGVdKTtcbiAgfVxuXG4gIGRyb3BJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nLCBpbmRleGVzOiBhbnksIGNvbm46IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHF1ZXJpZXMgPSBpbmRleGVzLm1hcChpID0+ICh7cXVlcnk6ICdEUk9QIElOREVYICQxOm5hbWUnLCB2YWx1ZXM6IGl9KSk7XG4gICAgcmV0dXJuIChjb25uIHx8IHRoaXMuX2NsaWVudCkudHgodCA9PiB0Lm5vbmUodGhpcy5fcGdwLmhlbHBlcnMuY29uY2F0KHF1ZXJpZXMpKSk7XG4gIH1cblxuICBnZXRJbmRleGVzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3QgcXMgPSAnU0VMRUNUICogRlJPTSBwZ19pbmRleGVzIFdIRVJFIHRhYmxlbmFtZSA9ICR7Y2xhc3NOYW1lfSc7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5hbnkocXMsIHtjbGFzc05hbWV9KTtcbiAgfVxuXG4gIHVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb252ZXJ0UG9seWdvblRvU1FMKHBvbHlnb24pIHtcbiAgaWYgKHBvbHlnb24ubGVuZ3RoIDwgMykge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgIGBQb2x5Z29uIG11c3QgaGF2ZSBhdCBsZWFzdCAzIHZhbHVlc2BcbiAgICApO1xuICB9XG4gIGlmIChwb2x5Z29uWzBdWzBdICE9PSBwb2x5Z29uW3BvbHlnb24ubGVuZ3RoIC0gMV1bMF0gfHxcbiAgICBwb2x5Z29uWzBdWzFdICE9PSBwb2x5Z29uW3BvbHlnb24ubGVuZ3RoIC0gMV1bMV0pIHtcbiAgICBwb2x5Z29uLnB1c2gocG9seWdvblswXSk7XG4gIH1cbiAgY29uc3QgdW5pcXVlID0gcG9seWdvbi5maWx0ZXIoKGl0ZW0sIGluZGV4LCBhcikgPT4ge1xuICAgIGxldCBmb3VuZEluZGV4ID0gLTE7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhci5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgY29uc3QgcHQgPSBhcltpXTtcbiAgICAgIGlmIChwdFswXSA9PT0gaXRlbVswXSAmJlxuICAgICAgICAgIHB0WzFdID09PSBpdGVtWzFdKSB7XG4gICAgICAgIGZvdW5kSW5kZXggPSBpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIGZvdW5kSW5kZXggPT09IGluZGV4O1xuICB9KTtcbiAgaWYgKHVuaXF1ZS5sZW5ndGggPCAzKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgUGFyc2UuRXJyb3IuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgJ0dlb0pTT046IExvb3AgbXVzdCBoYXZlIGF0IGxlYXN0IDMgZGlmZmVyZW50IHZlcnRpY2VzJ1xuICAgICk7XG4gIH1cbiAgY29uc3QgcG9pbnRzID0gcG9seWdvbi5tYXAoKHBvaW50KSA9PiB7XG4gICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBhcnNlRmxvYXQocG9pbnRbMV0pLCBwYXJzZUZsb2F0KHBvaW50WzBdKSk7XG4gICAgcmV0dXJuIGAoJHtwb2ludFsxXX0sICR7cG9pbnRbMF19KWA7XG4gIH0pLmpvaW4oJywgJyk7XG4gIHJldHVybiBgKCR7cG9pbnRzfSlgO1xufVxuXG5mdW5jdGlvbiByZW1vdmVXaGl0ZVNwYWNlKHJlZ2V4KSB7XG4gIGlmICghcmVnZXguZW5kc1dpdGgoJ1xcbicpKXtcbiAgICByZWdleCArPSAnXFxuJztcbiAgfVxuXG4gIC8vIHJlbW92ZSBub24gZXNjYXBlZCBjb21tZW50c1xuICByZXR1cm4gcmVnZXgucmVwbGFjZSgvKFteXFxcXF0pIy4qXFxuL2dtaSwgJyQxJylcbiAgICAvLyByZW1vdmUgbGluZXMgc3RhcnRpbmcgd2l0aCBhIGNvbW1lbnRcbiAgICAucmVwbGFjZSgvXiMuKlxcbi9nbWksICcnKVxuICAgIC8vIHJlbW92ZSBub24gZXNjYXBlZCB3aGl0ZXNwYWNlXG4gICAgLnJlcGxhY2UoLyhbXlxcXFxdKVxccysvZ21pLCAnJDEnKVxuICAgIC8vIHJlbW92ZSB3aGl0ZXNwYWNlIGF0IHRoZSBiZWdpbm5pbmcgb2YgYSBsaW5lXG4gICAgLnJlcGxhY2UoL15cXHMrLywgJycpXG4gICAgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gcHJvY2Vzc1JlZ2V4UGF0dGVybihzKSB7XG4gIGlmIChzICYmIHMuc3RhcnRzV2l0aCgnXicpKXtcbiAgICAvLyByZWdleCBmb3Igc3RhcnRzV2l0aFxuICAgIHJldHVybiAnXicgKyBsaXRlcmFsaXplUmVnZXhQYXJ0KHMuc2xpY2UoMSkpO1xuXG4gIH0gZWxzZSBpZiAocyAmJiBzLmVuZHNXaXRoKCckJykpIHtcbiAgICAvLyByZWdleCBmb3IgZW5kc1dpdGhcbiAgICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChzLnNsaWNlKDAsIHMubGVuZ3RoIC0gMSkpICsgJyQnO1xuICB9XG5cbiAgLy8gcmVnZXggZm9yIGNvbnRhaW5zXG4gIHJldHVybiBsaXRlcmFsaXplUmVnZXhQYXJ0KHMpO1xufVxuXG5mdW5jdGlvbiBpc1N0YXJ0c1dpdGhSZWdleCh2YWx1ZSkge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gJ3N0cmluZycgfHwgIXZhbHVlLnN0YXJ0c1dpdGgoJ14nKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IG1hdGNoZXMgPSB2YWx1ZS5tYXRjaCgvXFxeXFxcXFEuKlxcXFxFLyk7XG4gIHJldHVybiAhIW1hdGNoZXM7XG59XG5cbmZ1bmN0aW9uIGlzQWxsVmFsdWVzUmVnZXhPck5vbmUodmFsdWVzKSB7XG4gIGlmICghdmFsdWVzIHx8ICFBcnJheS5pc0FycmF5KHZhbHVlcykgfHwgdmFsdWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgY29uc3QgZmlyc3RWYWx1ZXNJc1JlZ2V4ID0gaXNTdGFydHNXaXRoUmVnZXgodmFsdWVzWzBdLiRyZWdleCk7XG4gIGlmICh2YWx1ZXMubGVuZ3RoID09PSAxKSB7XG4gICAgcmV0dXJuIGZpcnN0VmFsdWVzSXNSZWdleDtcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAxLCBsZW5ndGggPSB2YWx1ZXMubGVuZ3RoOyBpIDwgbGVuZ3RoOyArK2kpIHtcbiAgICBpZiAoZmlyc3RWYWx1ZXNJc1JlZ2V4ICE9PSBpc1N0YXJ0c1dpdGhSZWdleCh2YWx1ZXNbaV0uJHJlZ2V4KSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBpc0FueVZhbHVlUmVnZXhTdGFydHNXaXRoKHZhbHVlcykge1xuICByZXR1cm4gdmFsdWVzLnNvbWUoZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgcmV0dXJuIGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlLiRyZWdleCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVMaXRlcmFsUmVnZXgocmVtYWluaW5nKSB7XG4gIHJldHVybiByZW1haW5pbmcuc3BsaXQoJycpLm1hcChjID0+IHtcbiAgICBpZiAoYy5tYXRjaCgvWzAtOWEtekEtWl0vKSAhPT0gbnVsbCkge1xuICAgICAgLy8gZG9uJ3QgZXNjYXBlIGFscGhhbnVtZXJpYyBjaGFyYWN0ZXJzXG4gICAgICByZXR1cm4gYztcbiAgICB9XG4gICAgLy8gZXNjYXBlIGV2ZXJ5dGhpbmcgZWxzZSAoc2luZ2xlIHF1b3RlcyB3aXRoIHNpbmdsZSBxdW90ZXMsIGV2ZXJ5dGhpbmcgZWxzZSB3aXRoIGEgYmFja3NsYXNoKVxuICAgIHJldHVybiBjID09PSBgJ2AgPyBgJydgIDogYFxcXFwke2N9YDtcbiAgfSkuam9pbignJyk7XG59XG5cbmZ1bmN0aW9uIGxpdGVyYWxpemVSZWdleFBhcnQoczogc3RyaW5nKSB7XG4gIGNvbnN0IG1hdGNoZXIxID0gL1xcXFxRKCg/IVxcXFxFKS4qKVxcXFxFJC9cbiAgY29uc3QgcmVzdWx0MTogYW55ID0gcy5tYXRjaChtYXRjaGVyMSk7XG4gIGlmKHJlc3VsdDEgJiYgcmVzdWx0MS5sZW5ndGggPiAxICYmIHJlc3VsdDEuaW5kZXggPiAtMSkge1xuICAgIC8vIHByb2Nlc3MgcmVnZXggdGhhdCBoYXMgYSBiZWdpbm5pbmcgYW5kIGFuIGVuZCBzcGVjaWZpZWQgZm9yIHRoZSBsaXRlcmFsIHRleHRcbiAgICBjb25zdCBwcmVmaXggPSBzLnN1YnN0cigwLCByZXN1bHQxLmluZGV4KTtcbiAgICBjb25zdCByZW1haW5pbmcgPSByZXN1bHQxWzFdO1xuXG4gICAgcmV0dXJuIGxpdGVyYWxpemVSZWdleFBhcnQocHJlZml4KSArIGNyZWF0ZUxpdGVyYWxSZWdleChyZW1haW5pbmcpO1xuICB9XG5cbiAgLy8gcHJvY2VzcyByZWdleCB0aGF0IGhhcyBhIGJlZ2lubmluZyBzcGVjaWZpZWQgZm9yIHRoZSBsaXRlcmFsIHRleHRcbiAgY29uc3QgbWF0Y2hlcjIgPSAvXFxcXFEoKD8hXFxcXEUpLiopJC9cbiAgY29uc3QgcmVzdWx0MjogYW55ID0gcy5tYXRjaChtYXRjaGVyMik7XG4gIGlmKHJlc3VsdDIgJiYgcmVzdWx0Mi5sZW5ndGggPiAxICYmIHJlc3VsdDIuaW5kZXggPiAtMSl7XG4gICAgY29uc3QgcHJlZml4ID0gcy5zdWJzdHIoMCwgcmVzdWx0Mi5pbmRleCk7XG4gICAgY29uc3QgcmVtYWluaW5nID0gcmVzdWx0MlsxXTtcblxuICAgIHJldHVybiBsaXRlcmFsaXplUmVnZXhQYXJ0KHByZWZpeCkgKyBjcmVhdGVMaXRlcmFsUmVnZXgocmVtYWluaW5nKTtcbiAgfVxuXG4gIC8vIHJlbW92ZSBhbGwgaW5zdGFuY2VzIG9mIFxcUSBhbmQgXFxFIGZyb20gdGhlIHJlbWFpbmluZyB0ZXh0ICYgZXNjYXBlIHNpbmdsZSBxdW90ZXNcbiAgcmV0dXJuIChcbiAgICBzLnJlcGxhY2UoLyhbXlxcXFxdKShcXFxcRSkvLCAnJDEnKVxuICAgICAgLnJlcGxhY2UoLyhbXlxcXFxdKShcXFxcUSkvLCAnJDEnKVxuICAgICAgLnJlcGxhY2UoL15cXFxcRS8sICcnKVxuICAgICAgLnJlcGxhY2UoL15cXFxcUS8sICcnKVxuICAgICAgLnJlcGxhY2UoLyhbXiddKScvLCBgJDEnJ2ApXG4gICAgICAucmVwbGFjZSgvXicoW14nXSkvLCBgJyckMWApXG4gICk7XG59XG5cbnZhciBHZW9Qb2ludENvZGVyID0ge1xuICBpc1ZhbGlkSlNPTih2YWx1ZSkge1xuICAgIHJldHVybiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJlxuICAgICAgdmFsdWUgIT09IG51bGwgJiZcbiAgICAgIHZhbHVlLl9fdHlwZSA9PT0gJ0dlb1BvaW50J1xuICAgICk7XG4gIH1cbn07XG5cbmV4cG9ydCBkZWZhdWx0IFBvc3RncmVzU3RvcmFnZUFkYXB0ZXI7XG4iXX0=