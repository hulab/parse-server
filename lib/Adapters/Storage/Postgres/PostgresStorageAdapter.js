"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.PostgresStorageAdapter = void 0;
var _PostgresClient = require("./PostgresClient");
var _node = _interopRequireDefault(require("parse/node"));
var _lodash = _interopRequireDefault(require("lodash"));
var _crypto = require("crypto");
var _sql = _interopRequireDefault(require("./sql"));
var _StorageAdapter = require("../StorageAdapter");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
// -disable-next
// -disable-next
// -disable-next
const Utils = require('../../../Utils');
const PostgresRelationDoesNotExistError = '42P01';
const PostgresDuplicateRelationError = '42P07';
const PostgresDuplicateColumnError = '42701';
const PostgresMissingColumnError = '42703';
const PostgresUniqueIndexViolationError = '23505';
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
      return 'text';
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
  $gt: '>',
  $lt: '<',
  $gte: '>=',
  $lte: '<='
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
const toPostgresValueCastType = value => {
  const postgresValue = toPostgresValue(value);
  let castType;
  switch (typeof postgresValue) {
    case 'number':
      castType = 'double precision';
      break;
    case 'boolean':
      castType = 'boolean';
      break;
    default:
      castType = undefined;
  }
  return castType;
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
  count: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
  protectedFields: {}
});
const defaultCLPS = Object.freeze({
  ACL: {
    '*': {
      read: true,
      write: true
    }
  },
  find: {
    '*': true
  },
  get: {
    '*': true
  },
  count: {
    '*': true
  },
  create: {
    '*': true
  },
  update: {
    '*': true
  },
  delete: {
    '*': true
  },
  addField: {
    '*': true
  },
  protectedFields: {
    '*': []
  }
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
    clps = {
      ...emptyCLPS,
      ...schema.classLevelPermissions
    };
  }
  let indexes = {};
  if (schema.indexes) {
    indexes = {
      ...schema.indexes
    };
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
  schema.fields._wperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };
  schema.fields._rperm = {
    type: 'Array',
    contents: {
      type: 'String'
    }
  };
  if (schema.className === '_User') {
    schema.fields._hashed_password = {
      type: 'String'
    };
    schema.fields._password_history = {
      type: 'Array'
    };
  }
  return schema;
};
const isArrayIndex = arrayIndex => Array.from(arrayIndex).every(c => c >= '0' && c <= '9');
const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      // Only descend into an own object, never an inherited prototype member
      object[first] = Object.hasOwn(object, first) && object[first] && typeof object[first] === 'object' ? object[first] : {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      while (next = components.shift()) {
        if (components.length === 0) {
          currentObj[next] = value;
        } else {
          currentObj[next] = Object.hasOwn(currentObj, next) && currentObj[next] && typeof currentObj[next] === 'object' ? currentObj[next] : {};
          currentObj = currentObj[next];
        }
      }
      delete object[fieldName];
    }
  });
  return object;
};
const escapeSqlString = value => value.replace(/'/g, "''");
const escapeJsonString = value => JSON.stringify(value).slice(1, -1);
const transformDotFieldToComponents = fieldName => {
  return fieldName.split('.').map((cmpt, index) => {
    if (index === 0) {
      return `"${cmpt.replace(/"/g, '""')}"`;
    }
    if (isArrayIndex(cmpt)) {
      return Number(cmpt);
    } else {
      return `'${escapeSqlString(cmpt)}'`;
    }
  });
};
const transformDotField = fieldName => {
  if (fieldName.indexOf('.') === -1) {
    return `"${fieldName.replace(/"/g, '""')}"`;
  }
  const components = transformDotFieldToComponents(fieldName);
  let name = components.slice(0, components.length - 1).join('->');
  name += '->>' + components[components.length - 1];
  return name;
};
const validateAggregateFieldName = name => {
  if (typeof name !== 'string' || !name.match(/^[a-zA-Z][a-zA-Z0-9_]*$/)) {
    throw new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, `Invalid field name: ${name}`);
  }
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
  if (!fieldName.startsWith('$')) {
    throw new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}`);
  }
  const name = fieldName.substring(1);
  validateAggregateFieldName(name);
  return name;
};
const validateKeys = object => {
  if (typeof object == 'object') {
    for (const key in object) {
      if (typeof object[key] == 'object') {
        validateKeys(object[key]);
      }
      if (key.includes('$') || key.includes('.')) {
        throw new _node.default.Error(_node.default.Error.INVALID_NESTED_KEY, "Nested keys should not contain the '$' or '.' characters");
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
const buildWhereClause = ({
  schema,
  query,
  index,
  caseInsensitive
}) => {
  const patterns = [];
  let values = [];
  const sorts = [];
  schema = toPostgresSchema(schema);
  for (const fieldName in query) {
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const initialPatternsLength = patterns.length;
    const fieldValue = query[fieldName];

    // nothing in the schema, it's gonna blow up
    if (!schema.fields[fieldName]) {
      // as it won't exist
      if (fieldValue && fieldValue.$exists === false) {
        continue;
      }
    }
    const authDataMatch = fieldName.match(/^_auth_data_([a-zA-Z0-9_]+)$/);
    if (authDataMatch) {
      // TODO: Handle querying by _auth_data_provider, authData is stored in authData field
      continue;
    } else if (caseInsensitive && (fieldName === 'username' || fieldName === 'email')) {
      patterns.push(`LOWER($${index}:name) = LOWER($${index + 1})`);
      values.push(fieldName, fieldValue);
      index += 2;
    } else if (fieldName.indexOf('.') >= 0) {
      let name = transformDotField(fieldName);
      if (fieldValue === null) {
        patterns.push(`$${index}:raw IS NULL`);
        values.push(name);
        index += 1;
        continue;
      } else {
        if (fieldValue.$in) {
          name = transformDotFieldToComponents(fieldName).join('->');
          patterns.push(`($${index}:raw)::jsonb @> $${index + 1}::jsonb`);
          values.push(name, JSON.stringify(fieldValue.$in));
          index += 2;
        } else if (fieldValue.$regex) {
          // Handle later
        } else if (typeof fieldValue !== 'object') {
          patterns.push(`$${index}:raw = $${index + 1}::text`);
          values.push(name, fieldValue);
          index += 2;
        } else if (typeof fieldValue === 'object' && !Object.keys(fieldValue).some(key => key.startsWith('$'))) {
          name = transformDotFieldToComponents(fieldName).join('->');
          patterns.push(`($${index}:raw)::jsonb = $${index + 1}::jsonb`);
          values.push(name, JSON.stringify(fieldValue));
          index += 2;
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
        const clause = buildWhereClause({
          schema,
          query: subQuery,
          index,
          caseInsensitive
        });
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
          if (fieldValue.$ne.__type === 'GeoPoint') {
            patterns.push(`($${index}:name <> POINT($${index + 1}, $${index + 2}) OR $${index}:name IS NULL)`);
          } else {
            if (fieldName.indexOf('.') >= 0) {
              const castType = toPostgresValueCastType(fieldValue.$ne);
              const constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
              patterns.push(`(${constraintFieldName} <> $${index + 1} OR ${constraintFieldName} IS NULL)`);
            } else if (typeof fieldValue.$ne === 'object' && fieldValue.$ne.$relativeTime) {
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
            } else {
              patterns.push(`($${index}:name <> $${index + 1} OR $${index}:name IS NULL)`);
            }
          }
        }
      }
      if (fieldValue.$ne.__type === 'GeoPoint') {
        const point = fieldValue.$ne;
        values.push(fieldName, point.longitude, point.latitude);
        index += 3;
      } else {
        // TODO: support arrays
        values.push(fieldName, fieldValue.$ne);
        index += 2;
      }
    }
    if (fieldValue.$eq !== undefined) {
      if (fieldValue.$eq === null) {
        patterns.push(`$${index}:name IS NULL`);
        values.push(fieldName);
        index += 1;
      } else {
        if (fieldName.indexOf('.') >= 0) {
          const castType = toPostgresValueCastType(fieldValue.$eq);
          const constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
          values.push(fieldValue.$eq);
          patterns.push(`${constraintFieldName} = $${index++}`);
        } else if (typeof fieldValue.$eq === 'object' && fieldValue.$eq.$relativeTime) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
        } else {
          values.push(fieldName, fieldValue.$eq);
          patterns.push(`$${index}:name = $${index + 1}`);
          index += 2;
        }
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
        const not = notIn ? ' NOT ' : '';
        if (baseArray.length > 0) {
          if (isArrayField) {
            patterns.push(`${not} array_contains($${index}:name, $${index + 1})`);
            values.push(fieldName, JSON.stringify(baseArray));
            index += 2;
          } else {
            // Handle Nested Dot Notation Above
            if (fieldName.indexOf('.') >= 0) {
              return;
            }
            const fieldType = schema.fields[fieldName]?.type;
            if (fieldType === 'String') {
              const operatorName = notIn ? '$nin' : '$in';
              for (const elem of baseArray) {
                if (elem != null && typeof elem !== 'string') {
                  throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `${operatorName} element type mismatch: expected string for field "${fieldName}"`);
                }
              }
            }
            const inPatterns = [];
            values.push(fieldName);
            baseArray.forEach((listElem, listIndex) => {
              if (listElem != null) {
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
        } else {
          // Handle empty array
          if (notIn) {
            patterns.push('1 = 1'); // Return all values
          } else {
            patterns.push('1 = 2'); // Return no values
          }
        }
      };
      if (fieldValue.$in) {
        createConstraint(_lodash.default.flatMap(fieldValue.$in, elt => elt), false);
      }
      if (fieldValue.$nin) {
        createConstraint(_lodash.default.flatMap(fieldValue.$nin, elt => elt), true);
      }
    } else if (typeof fieldValue.$in !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $in value');
    } else if (typeof fieldValue.$nin !== 'undefined') {
      throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $nin value');
    }
    if (Array.isArray(fieldValue.$all) && isArrayField) {
      if (isAnyValueRegexStartsWith(fieldValue.$all)) {
        if (!isAllValuesRegexOrNone(fieldValue.$all)) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'All $all values must be of regex type or none: ' + fieldValue.$all);
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
    } else if (Array.isArray(fieldValue.$all)) {
      if (fieldValue.$all.length === 1) {
        patterns.push(`$${index}:name = $${index + 1}`);
        values.push(fieldName, fieldValue.$all[0].objectId);
        index += 2;
      }
    }
    if (typeof fieldValue.$exists !== 'undefined') {
      if (typeof fieldValue.$exists === 'object' && fieldValue.$exists.$relativeTime) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators');
      } else if (fieldValue.$exists) {
        patterns.push(`$${index}:name IS NOT NULL`);
      } else {
        patterns.push(`$${index}:name IS NULL`);
      }
      values.push(fieldName);
      index += 1;
    }
    if (fieldValue.$containedBy) {
      const arr = fieldValue.$containedBy;
      if (!Array.isArray(arr)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $containedBy: should be an array`);
      }
      patterns.push(`$${index}:name <@ $${index + 1}::jsonb`);
      values.push(fieldName, JSON.stringify(arr));
      index += 2;
    }
    if (fieldValue.$text) {
      const search = fieldValue.$text.$search;
      let language = 'english';
      if (typeof search !== 'object') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $search, should be object`);
      }
      if (!search.$term || typeof search.$term !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $term, should be string`);
      }
      if (search.$language && typeof search.$language !== 'string') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $language, should be string`);
      } else if (search.$language) {
        language = search.$language;
      }
      if (search.$caseSensitive && typeof search.$caseSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive, should be boolean`);
      } else if (search.$caseSensitive) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $caseSensitive not supported, please use $regex or create a separate lower case column.`);
      }
      if (search.$diacriticSensitive && typeof search.$diacriticSensitive !== 'boolean') {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive, should be boolean`);
      } else if (search.$diacriticSensitive === false) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $text: $diacriticSensitive - false not supported, install Postgres Unaccent Extension`);
      }
      patterns.push(`to_tsvector($${index}, $${index + 1}:name) @@ to_tsquery($${index + 2}, $${index + 3})`);
      values.push(language, fieldName, language, search.$term);
      index += 4;
    }
    if (fieldValue.$nearSphere) {
      const point = fieldValue.$nearSphere;
      const distance = fieldValue.$maxDistance;
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      sorts.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) ASC`);
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
      if (!Array.isArray(centerSphere) || centerSphere.length < 2) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance');
      }
      // Get point, convert to geo point if necessary and validate
      let point = centerSphere[0];
      if (Array.isArray(point) && point.length === 2) {
        point = new _node.default.GeoPoint(point[1], point[0]);
      } else if (!GeoPointCoder.isValidJSON(point)) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere geo point invalid');
      }
      _node.default.GeoPoint._validate(point.latitude, point.longitude);
      // Get distance and validate
      const distance = centerSphere[1];
      if (isNaN(distance) || distance < 0) {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $centerSphere distance invalid');
      }
      const distanceInKM = distance * 6371 * 1000;
      patterns.push(`ST_DistanceSphere($${index}:name::geometry, POINT($${index + 1}, $${index + 2})::geometry) <= $${index + 3}`);
      values.push(fieldName, point.longitude, point.latitude, distanceInKM);
      index += 4;
    }
    if (fieldValue.$geoWithin && fieldValue.$geoWithin.$polygon) {
      const polygon = fieldValue.$geoWithin.$polygon;
      let points;
      if (typeof polygon === 'object' && polygon.__type === 'Polygon') {
        if (!polygon.coordinates || polygon.coordinates.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; Polygon.coordinates should contain at least 3 lon/lat pairs');
        }
        points = polygon.coordinates;
      } else if (Array.isArray(polygon)) {
        if (polygon.length < 3) {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value; $polygon should contain at least 3 GeoPoints');
        }
        points = polygon;
      } else {
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, "bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint's");
      }
      points = points.map(point => {
        if (Array.isArray(point) && point.length === 2) {
          _node.default.GeoPoint._validate(point[1], point[0]);
          return `(${point[0]}, ${point[1]})`;
        }
        if (typeof point !== 'object' || point.__type !== 'GeoPoint') {
          throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoWithin value');
        } else {
          _node.default.GeoPoint._validate(point.latitude, point.longitude);
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
        throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'bad $geoIntersect value; $point should be GeoPoint');
      } else {
        _node.default.GeoPoint._validate(point.latitude, point.longitude);
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
      regex = processRegexPattern(regex);
      if (fieldName.indexOf('.') >= 0) {
        const name = transformDotField(fieldName);
        patterns.push(`$${index}:raw ${operator} '$${index + 1}:raw'`);
        values.push(name, regex);
      } else {
        patterns.push(`$${index}:name ${operator} '$${index + 1}:raw'`);
        values.push(fieldName, regex);
      }
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
      patterns.push(`$${index}:name ~= POINT($${index + 1}, $${index + 2})`);
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
        let constraintFieldName;
        let postgresValue = toPostgresValue(fieldValue[cmp]);
        if (fieldName.indexOf('.') >= 0) {
          const castType = toPostgresValueCastType(fieldValue[cmp]);
          constraintFieldName = castType ? `CAST ((${transformDotField(fieldName)}) AS ${castType})` : transformDotField(fieldName);
        } else {
          if (typeof postgresValue === 'object' && postgresValue.$relativeTime) {
            if (schema.fields[fieldName].type !== 'Date') {
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, '$relativeTime can only be used with Date field');
            }
            const parserResult = Utils.relativeTimeToDate(postgresValue.$relativeTime);
            if (parserResult.status === 'success') {
              postgresValue = toPostgresValue(parserResult.result);
            } else {
              // eslint-disable-next-line no-console
              console.error('Error while parsing relative date', parserResult);
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, `bad $relativeTime (${postgresValue.$relativeTime}) value. ${parserResult.info}`);
            }
          }
          constraintFieldName = `$${index++}:name`;
          values.push(fieldName);
        }
        values.push(postgresValue);
        patterns.push(`${constraintFieldName} ${pgComparator} $${index++}`);
      }
    });
    if (initialPatternsLength === patterns.length) {
      throw new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support this query type yet ${JSON.stringify(fieldValue)}`);
    }
  }
  values = values.map(transformValue);
  return {
    pattern: patterns.join(' AND '),
    values,
    sorts
  };
};
class PostgresStorageAdapter {
  // Private

  constructor({
    uri,
    collectionPrefix = '',
    databaseOptions = {}
  }) {
    const options = {
      ...databaseOptions
    };
    this._collectionPrefix = collectionPrefix;
    this.enableSchemaHooks = !!databaseOptions.enableSchemaHooks;
    this.disableIndexFieldValidation = !!databaseOptions.disableIndexFieldValidation;
    this.schemaCacheTtl = databaseOptions.schemaCacheTtl;
    for (const key of ['enableSchemaHooks', 'schemaCacheTtl', 'disableIndexFieldValidation']) {
      delete options[key];
    }
    const {
      client,
      pgp
    } = (0, _PostgresClient.createClient)(uri, options);
    this._client = client;
    this._onchange = () => {};
    this._pgp = pgp;
    this._uuid = (0, _crypto.randomUUID)();
    this.canSortOnJoinTables = false;
  }
  watch(callback) {
    this._onchange = callback;
  }

  //Note that analyze=true will run the query, executing INSERTS, DELETES, etc.
  createExplainableQuery(query, analyze = false) {
    if (analyze) {
      return 'EXPLAIN (ANALYZE, FORMAT JSON) ' + query;
    } else {
      return 'EXPLAIN (FORMAT JSON) ' + query;
    }
  }
  handleShutdown() {
    if (this._stream) {
      this._stream.done();
      delete this._stream;
    }
    if (!this._client) {
      return;
    }
    this._client.$pool.end();
  }
  async _listenToSchema() {
    if (!this._stream && this.enableSchemaHooks) {
      this._stream = await this._client.connect({
        direct: true
      });
      this._stream.client.on('notification', data => {
        const payload = JSON.parse(data.payload);
        if (payload.senderId !== this._uuid) {
          this._onchange();
        }
      });
      await this._stream.none('LISTEN $1~', 'schema.change');
    }
  }
  _notifySchemaChange() {
    if (this._stream) {
      this._stream.none('NOTIFY $1~, $2', ['schema.change', {
        senderId: this._uuid
      }]).catch(error => {
        // eslint-disable-next-line no-console
        console.log('Failed to Notify:', error); // unlikely to ever happen
      });
    }
  }
  async _ensureSchemaCollectionExists(conn) {
    conn = conn || this._client;
    await conn.none('CREATE TABLE IF NOT EXISTS "_SCHEMA" ( "className" varChar(120), "schema" jsonb, "isParseClass" bool, PRIMARY KEY ("className") )').catch(error => {
      throw error;
    });
  }
  async classExists(name) {
    return this._client.one('SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)', [name], a => a.exists);
  }
  async setClassLevelPermissions(className, CLPs) {
    await this._client.task('set-class-level-permissions', async t => {
      const values = [className, 'schema', 'classLevelPermissions', JSON.stringify(CLPs)];
      await t.none(`UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className" = $1`, values);
    });
    this._notifySchemaChange();
  }
  async setIndexesWithSchemaFormat(className, submittedIndexes, existingIndexes = {}, fields, conn) {
    conn = conn || this._client;
    const self = this;
    if (submittedIndexes === undefined) {
      return Promise.resolve();
    }
    if (Object.keys(existingIndexes).length === 0) {
      existingIndexes = {
        _id_: {
          _id: 1
        }
      };
    }
    const deletedIndexes = [];
    const insertedIndexes = [];
    Object.keys(submittedIndexes).forEach(name => {
      const field = submittedIndexes[name];
      if (existingIndexes[name] && field.__op !== 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!existingIndexes[name] && field.__op === 'Delete') {
        throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Index ${name} does not exist, cannot delete.`);
      }
      if (field.__op === 'Delete') {
        deletedIndexes.push(name);
        delete existingIndexes[name];
      } else {
        Object.keys(field).forEach(key => {
          if (!this.disableIndexFieldValidation && !Object.prototype.hasOwnProperty.call(fields, key)) {
            throw new _node.default.Error(_node.default.Error.INVALID_QUERY, `Field ${key} does not exist, cannot add index.`);
          }
        });
        existingIndexes[name] = field;
        insertedIndexes.push({
          key: field,
          name
        });
      }
    });
    await conn.tx('set-indexes-with-schema-format', async t => {
      try {
        if (insertedIndexes.length > 0) {
          await self.createIndexes(className, insertedIndexes, t);
        }
      } catch (e) {
        // pg-promise use Batch error see https://github.com/vitaly-t/spex/blob/e572030f261be1a8e9341fc6f637e36ad07f5231/src/errors/batch.js#L59
        const columnDoesNotExistError = e.getErrors && e.getErrors()[0] && e.getErrors()[0].code === '42703';
        // Specific case when the column does not exist
        if (columnDoesNotExistError) {
          // If the disableIndexFieldValidation is true, we should ignore the error
          if (!this.disableIndexFieldValidation) {
            throw e;
          }
        } else {
          throw e;
        }
      }
      if (deletedIndexes.length > 0) {
        await self.dropIndexes(className, deletedIndexes, t);
      }
      await t.none('UPDATE "_SCHEMA" SET $2:name = json_object_set_key($2:name, $3::text, $4::jsonb) WHERE "className" = $1', [className, 'schema', 'indexes', JSON.stringify(existingIndexes)]);
    });
    this._notifySchemaChange();
  }
  async createClass(className, schema, conn) {
    conn = conn || this._client;
    const parseSchema = await conn.tx('create-class', async t => {
      await this.createTable(className, schema, t);
      await t.none('INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES ($<className>, $<schema>, true)', {
        className,
        schema
      });
      await this.setIndexesWithSchemaFormat(className, schema.indexes, {}, schema.fields, t);
      return toParseSchema(schema);
    }).catch(err => {
      if (err.code === PostgresUniqueIndexViolationError && err.detail.includes(className)) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
      }
      throw err;
    });
    this._notifySchemaChange();
    return parseSchema;
  }

  // Just create a table, do not insert in schema
  async createTable(className, schema, conn) {
    conn = conn || this._client;
    debug('createTable');
    const valuesArray = [];
    const patternsArray = [];
    const fields = Object.assign({}, schema.fields);
    if (className === '_User') {
      fields._email_verify_token_expires_at = {
        type: 'Date'
      };
      fields._email_verify_token = {
        type: 'String'
      };
      fields._account_lockout_expires_at = {
        type: 'Date'
      };
      fields._failed_login_count = {
        type: 'Number'
      };
      fields._perishable_token = {
        type: 'String'
      };
      fields._perishable_token_expires_at = {
        type: 'Date'
      };
      fields._password_changed_at = {
        type: 'Date'
      };
      fields._password_history = {
        type: 'Array'
      };
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
        parseType.contents = {
          type: 'String'
        };
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
    return conn.task('create-table', async t => {
      try {
        await t.none(qs, values);
      } catch (error) {
        if (error.code !== PostgresDuplicateRelationError) {
          throw error;
        }
        // ELSE: Table already exists, must have been created by a different request. Ignore the error.
      }
      await t.tx('create-table-tx', tx => {
        return tx.batch(relations.map(fieldName => {
          return tx.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
            joinTable: `_Join:${fieldName}:${className}`
          });
        }));
      });
    });
  }
  async schemaUpgrade(className, schema, conn) {
    debug('schemaUpgrade');
    conn = conn || this._client;
    const self = this;
    await conn.task('schema-upgrade', async t => {
      const columns = await t.map('SELECT column_name FROM information_schema.columns WHERE table_name = $<className>', {
        className
      }, a => a.column_name);
      const newColumns = Object.keys(schema.fields).filter(item => columns.indexOf(item) === -1).map(fieldName => self.addFieldIfNotExists(className, fieldName, schema.fields[fieldName]));
      await t.batch(newColumns);
    });
  }
  async addFieldIfNotExists(className, fieldName, type) {
    // TODO: Must be revised for invalid logic...
    debug('addFieldIfNotExists');
    const self = this;
    await this._client.tx('add-field-if-not-exists', async t => {
      if (type.type !== 'Relation') {
        try {
          await t.none('ALTER TABLE $<className:name> ADD COLUMN IF NOT EXISTS $<fieldName:name> $<postgresType:raw>', {
            className,
            fieldName,
            postgresType: parseTypeToPostgresType(type)
          });
        } catch (error) {
          if (error.code === PostgresRelationDoesNotExistError) {
            return self.createClass(className, {
              fields: {
                [fieldName]: type
              }
            }, t);
          }
          if (error.code !== PostgresDuplicateColumnError) {
            throw error;
          }
          // Column already exists, created by other request. Carry on to see if it's the right type.
        }
      } else {
        await t.none('CREATE TABLE IF NOT EXISTS $<joinTable:name> ("relatedId" varChar(120), "owningId" varChar(120), PRIMARY KEY("relatedId", "owningId") )', {
          joinTable: `_Join:${fieldName}:${className}`
        });
      }
      const result = await t.any('SELECT "schema" FROM "_SCHEMA" WHERE "className" = $<className> and ("schema"::json->\'fields\'->$<fieldName>) is not null', {
        className,
        fieldName
      });
      if (result[0]) {
        throw 'Attempted to add a field that already exists';
      } else {
        const path = `{fields,${fieldName}}`;
        await t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', {
          path,
          type,
          className
        });
      }
    });
    this._notifySchemaChange();
  }
  async updateFieldOptions(className, fieldName, type) {
    await this._client.tx('update-schema-field-options', async t => {
      const path = `{fields,${fieldName}}`;
      await t.none('UPDATE "_SCHEMA" SET "schema"=jsonb_set("schema", $<path>, $<type>)  WHERE "className"=$<className>', {
        path,
        type,
        className
      });
    });
  }

  // Drops a collection. Resolves with true if it was a Parse Schema (eg. _User, Custom, etc.)
  // and resolves with false if it wasn't (eg. a join table). Rejects if deletion was impossible.
  async deleteClass(className) {
    const operations = [{
      query: `DROP TABLE IF EXISTS $1:name`,
      values: [className]
    }, {
      query: `DELETE FROM "_SCHEMA" WHERE "className" = $1`,
      values: [className]
    }];
    const response = await this._client.tx(t => t.none(this._pgp.helpers.concat(operations))).then(() => className.indexOf('_Join:') != 0); // resolves with false when _Join table

    this._notifySchemaChange();
    return response;
  }

  // Delete all data known to this adapter. Used for testing.
  async deleteAllClasses() {
    const now = new Date().getTime();
    const helpers = this._pgp.helpers;
    debug('deleteAllClasses');
    if (this._client?.$pool.ended) {
      return;
    }
    await this._client.task('delete-all-classes', async t => {
      try {
        const results = await t.any('SELECT * FROM "_SCHEMA"');
        const joins = results.reduce((list, schema) => {
          return list.concat(joinTablesForSchema(schema.schema));
        }, []);
        const classes = ['_SCHEMA', '_PushStatus', '_JobStatus', '_JobSchedule', '_Hooks', '_GlobalConfig', '_GraphQLConfig', '_Audience', '_Idempotency', ...results.map(result => result.className), ...joins];
        const queries = classes.map(className => ({
          query: 'DROP TABLE IF EXISTS $<className:name>',
          values: {
            className
          }
        }));
        await t.tx(tx => tx.none(helpers.concat(queries)));
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
  async deleteFields(className, schema, fieldNames) {
    debug('deleteFields');
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
    await this._client.tx('delete-fields', async t => {
      await t.none('UPDATE "_SCHEMA" SET "schema" = $<schema> WHERE "className" = $<className>', {
        schema,
        className
      });
      if (values.length > 1) {
        await t.none(`ALTER TABLE $1:name DROP COLUMN IF EXISTS ${columns}`, values);
      }
    });
    this._notifySchemaChange();
  }

  // Return a promise for all schemas known to this adapter, in Parse format. In case the
  // schemas cannot be retrieved, returns a promise that rejects. Requirements for the
  // rejection reason are TBD.
  async getAllClasses() {
    return this._client.task('get-all-classes', async t => {
      return await t.map('SELECT * FROM "_SCHEMA"', null, row => toParseSchema({
        className: row.className,
        ...row.schema
      }));
    });
  }

  // Return a promise for the schema with the given name, in Parse format. If
  // this adapter doesn't know about the schema, return a promise that rejects with
  // undefined as the reason.
  async getClass(className) {
    debug('getClass');
    return this._client.any('SELECT * FROM "_SCHEMA" WHERE "className" = $<className>', {
      className
    }).then(result => {
      if (result.length !== 1) {
        throw undefined;
      }
      return result[0].schema;
    }).then(toParseSchema);
  }

  // TODO: remove the mongo format dependency in the return value
  async createObject(className, schema, object, transactionalSession) {
    debug('createObject');
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
      const authDataAlreadyExists = !!object.authData;
      if (authDataMatch) {
        var provider = authDataMatch[1];
        object['authData'] = object['authData'] || {};
        object['authData'][provider] = object[fieldName];
        delete object[fieldName];
        fieldName = 'authData';
        // Avoid adding authData multiple times to the query
        if (authDataAlreadyExists) {
          return;
        }
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
    const promise = (transactionalSession ? transactionalSession.t : this._client).none(qs, values).then(() => ({
      ops: [object]
    })).catch(error => {
      if (error.code === PostgresUniqueIndexViolationError) {
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.constraint) {
          // Check for authData unique index violations first
          const authDataMatch = error.constraint.match(/_User_unique_authData_([a-zA-Z0-9_]+)_id/);
          if (authDataMatch) {
            err.userInfo = {
              duplicated_field: `_auth_data_${authDataMatch[1]}`
            };
          } else {
            const matches = error.constraint.match(/unique_([a-zA-Z]+)/);
            if (matches && Array.isArray(matches)) {
              err.userInfo = {
                duplicated_field: matches[1]
              };
            }
          }
        }
        error = err;
      }
      throw error;
    });
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  // Remove all objects that match the given Parse Query.
  // If no objects match, reject with OBJECT_NOT_FOUND. If objects are found and deleted, resolve with undefined.
  // If there is some other error, reject with INTERNAL_SERVER_ERROR.
  async deleteObjectsByQuery(className, schema, query, transactionalSession) {
    debug('deleteObjectsByQuery');
    const values = [className];
    const index = 2;
    const where = buildWhereClause({
      schema,
      index,
      query,
      caseInsensitive: false
    });
    values.push(...where.values);
    if (Object.keys(query).length === 0) {
      where.pattern = 'TRUE';
    }
    const qs = `WITH deleted AS (DELETE FROM $1:name WHERE ${where.pattern} RETURNING *) SELECT count(*) FROM deleted`;
    const promise = (transactionalSession ? transactionalSession.t : this._client).one(qs, values, a => +a.count).then(count => {
      if (count === 0) {
        throw new _node.default.Error(_node.default.Error.OBJECT_NOT_FOUND, 'Object not found.');
      } else {
        return count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError) {
        throw error;
      }
      // ELSE: Don't delete anything if doesn't exist
    });
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }
  // Return value not currently well specified.
  async findOneAndUpdate(className, schema, query, update, transactionalSession) {
    debug('findOneAndUpdate');
    return this.updateObjectsByQuery(className, schema, query, update, transactionalSession).then(val => val[0]);
  }

  // Apply the update to all objects that match the given Parse Query.
  async updateObjectsByQuery(className, schema, query, update, transactionalSession) {
    debug('updateObjectsByQuery');
    const updatePatterns = [];
    const values = [className];
    let index = 2;
    schema = toPostgresSchema(schema);
    const originalUpdate = {
      ...update
    };

    // Set flag for dot notation fields
    const dotNotationOptions = {};
    Object.keys(update).forEach(fieldName => {
      if (fieldName.indexOf('.') > -1) {
        const components = fieldName.split('.');
        const first = components.shift();
        dotNotationOptions[first] = true;
      } else {
        dotNotationOptions[fieldName] = false;
      }
    });
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
      // Drop any undefined values.
      if (typeof fieldValue === 'undefined') {
        delete update[fieldName];
      } else if (fieldValue === null) {
        updatePatterns.push(`$${index}:name = NULL`);
        values.push(fieldName);
        index += 1;
      } else if (fieldName == 'authData') {
        // This recursively sets the json_object
        // Only 1 level deep
        const generate = (jsonb, key, value) => {
          return `json_object_set_key(COALESCE(${jsonb}, '{}'::jsonb), ${key}, ${value})::jsonb`;
        };
        const generateRemove = (jsonb, key) => {
          return `(COALESCE(${jsonb}, '{}'::jsonb) - ${key})`;
        };
        const lastKey = `$${index}:name`;
        const fieldNameIndex = index;
        index += 1;
        values.push(fieldName);
        const update = Object.keys(fieldValue).reduce((lastKey, key) => {
          let value = fieldValue[key];
          if (value && value.__op === 'Delete') {
            value = null;
          }
          if (value === null) {
            const str = generateRemove(lastKey, `$${index}::text`);
            values.push(key);
            index += 1;
            return str;
          }
          const str = generate(lastKey, `$${index}::text`, `$${index + 1}::jsonb`);
          index += 2;
          if (value) {
            value = JSON.stringify(value);
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
      } else if (Utils.isDate(fieldValue)) {
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
          return value && value.__op === 'Increment' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        let incrementPatterns = '';
        const incrementValues = [];
        if (keysToIncrement.length > 0) {
          incrementPatterns = ' || ' + keysToIncrement.map(c => {
            const amount = fieldValue[c].amount;
            if (typeof amount !== 'number') {
              throw new _node.default.Error(_node.default.Error.INVALID_JSON, 'incrementing must provide a number');
            }
            incrementValues.push(amount);
            const amountIndex = index + incrementValues.length;
            const jsonSafeName = escapeSqlString(escapeJsonString(c));
            const sqlSafeName = escapeSqlString(c);
            return `CONCAT('{"${jsonSafeName}":', COALESCE($${index}:name->>'${sqlSafeName}','0')::int + $${amountIndex}, '}')::jsonb`;
          }).join(' || ');
          // Strip the keys
          keysToIncrement.forEach(key => {
            delete fieldValue[key];
          });
        }
        const keysToDelete = Object.keys(originalUpdate).filter(k => {
          // choose top level fields that have a delete operation set.
          const value = originalUpdate[k];
          return value && value.__op === 'Delete' && k.split('.').length === 2 && k.split('.')[0] === fieldName;
        }).map(k => k.split('.')[1]);
        const deletePatterns = keysToDelete.reduce((p, c, i) => {
          return p + ` - '$${index + 1 + incrementValues.length + i}:value'`;
        }, '');
        // Override Object
        let updateObject = "'{}'::jsonb";
        if (dotNotationOptions[fieldName]) {
          // Merge Object
          updateObject = `COALESCE($${index}:name, '{}'::jsonb)`;
        }
        updatePatterns.push(`$${index}:name = (${updateObject} ${deletePatterns} ${incrementPatterns} || $${index + 1 + incrementValues.length + keysToDelete.length}::jsonb )`);
        values.push(fieldName, ...incrementValues, ...keysToDelete, JSON.stringify(fieldValue));
        index += 2 + incrementValues.length + keysToDelete.length;
      } else if (Array.isArray(fieldValue) && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array') {
        const expectedType = parseTypeToPostgresType(schema.fields[fieldName]);
        if (expectedType === 'text[]') {
          updatePatterns.push(`$${index}:name = $${index + 1}::text[]`);
          values.push(fieldName, fieldValue);
          index += 2;
        } else {
          updatePatterns.push(`$${index}:name = $${index + 1}::jsonb`);
          values.push(fieldName, JSON.stringify(fieldValue));
          index += 2;
        }
      } else {
        debug('Not supported update', {
          fieldName,
          fieldValue
        });
        return Promise.reject(new _node.default.Error(_node.default.Error.OPERATION_FORBIDDEN, `Postgres doesn't support update ${JSON.stringify(fieldValue)} yet`));
      }
    }
    const where = buildWhereClause({
      schema,
      index,
      query,
      caseInsensitive: false
    });
    values.push(...where.values);
    const whereClause = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const qs = `UPDATE $1:name SET ${updatePatterns.join()} ${whereClause} RETURNING *`;
    const promise = (transactionalSession ? transactionalSession.t : this._client).any(qs, values).catch(error => {
      if (error.code === PostgresUniqueIndexViolationError) {
        const err = new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
        err.underlyingError = error;
        if (error.constraint) {
          const authDataMatch = error.constraint.match(/_User_unique_authData_([a-zA-Z0-9_]+)_id/);
          if (authDataMatch) {
            err.userInfo = {
              duplicated_field: `_auth_data_${authDataMatch[1]}`
            };
          } else {
            const matches = error.constraint.match(/unique_([a-zA-Z]+)/);
            if (matches && Array.isArray(matches)) {
              err.userInfo = {
                duplicated_field: matches[1]
              };
            }
          }
        }
        throw err;
      }
      throw error;
    });
    if (transactionalSession) {
      transactionalSession.batch.push(promise);
    }
    return promise;
  }

  // Hopefully, we can get rid of this. It's only used for config and hooks.
  upsertOneObject(className, schema, query, update, transactionalSession) {
    debug('upsertOneObject');
    const createValue = Object.assign({}, query, update);
    return this.createObject(className, schema, createValue, transactionalSession).catch(error => {
      // ignore duplicate value errors as it's upsert
      if (error.code !== _node.default.Error.DUPLICATE_VALUE) {
        throw error;
      }
      return this.findOneAndUpdate(className, schema, query, update, transactionalSession);
    });
  }
  find(className, schema, query, {
    skip,
    limit,
    sort,
    keys,
    caseInsensitive,
    explain
  }) {
    debug('find');
    const hasLimit = limit !== undefined;
    const hasSkip = skip !== undefined;
    let values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2,
      caseInsensitive
    });
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
        } else if (key.length > 0 && (
        // Remove selected field not referenced in the schema
        // Relation is not a column in postgres
        // $score is a Parse special field and is also not a column
        schema.fields[key] && schema.fields[key].type !== 'Relation' || key === '$score')) {
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
    const originalQuery = `SELECT ${columns} FROM $1:name ${wherePattern} ${sortPattern} ${limitPattern} ${skipPattern}`;
    const qs = explain ? this.createExplainableQuery(originalQuery) : originalQuery;
    return this._client.any(qs, values).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError && error.code !== PostgresMissingColumnError) {
        throw error;
      }
      return [];
    }).then(results => {
      if (explain) {
        return results;
      }
      return results.map(object => this.postgresObjectToParseObject(className, object, schema));
    });
  }

  // Converts from a postgres-format object to a REST-format object.
  // Does not strip out anything based on a lack of authentication.
  postgresObjectToParseObject(className, object, schema) {
    Object.keys(schema.fields).forEach(fieldName => {
      if (schema.fields[fieldName].type === 'Pointer' && object[fieldName]) {
        object[fieldName] = {
          objectId: object[fieldName],
          __type: 'Pointer',
          className: schema.fields[fieldName].targetClass
        };
      }
      if (schema.fields[fieldName].type === 'Relation') {
        object[fieldName] = {
          __type: 'Relation',
          className: schema.fields[fieldName].targetClass
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'GeoPoint') {
        object[fieldName] = {
          __type: 'GeoPoint',
          latitude: object[fieldName].y,
          longitude: object[fieldName].x
        };
      }
      if (object[fieldName] && schema.fields[fieldName].type === 'Polygon') {
        let coords = new String(object[fieldName]);
        coords = coords.substring(2, coords.length - 2).split('),(');
        const updatedCoords = coords.map(point => {
          return [parseFloat(point.split(',')[1]), parseFloat(point.split(',')[0])];
        });
        object[fieldName] = {
          __type: 'Polygon',
          coordinates: updatedCoords
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
      object.expiresAt = {
        __type: 'Date',
        iso: object.expiresAt.toISOString()
      };
    }
    if (object._email_verify_token_expires_at) {
      object._email_verify_token_expires_at = {
        __type: 'Date',
        iso: object._email_verify_token_expires_at.toISOString()
      };
    }
    if (object._account_lockout_expires_at) {
      object._account_lockout_expires_at = {
        __type: 'Date',
        iso: object._account_lockout_expires_at.toISOString()
      };
    }
    if (object._perishable_token_expires_at) {
      object._perishable_token_expires_at = {
        __type: 'Date',
        iso: object._perishable_token_expires_at.toISOString()
      };
    }
    if (object._password_changed_at) {
      object._password_changed_at = {
        __type: 'Date',
        iso: object._password_changed_at.toISOString()
      };
    }
    for (const fieldName in object) {
      if (object[fieldName] === null) {
        delete object[fieldName];
      }
      if (Utils.isDate(object[fieldName])) {
        object[fieldName] = {
          __type: 'Date',
          iso: object[fieldName].toISOString()
        };
      }
    }
    return object;
  }

  // Create a unique index. Unique indexes on nullable fields are not allowed. Since we don't
  // currently know which fields are nullable and which aren't, we ignore that criteria.
  // As such, we shouldn't expose this function to users of parse until we have an out-of-band
  // Way of determining if a field is nullable. Undefined doesn't count against uniqueness,
  // which is why we use sparse indexes.
  async ensureUniqueness(className, schema, fieldNames) {
    const constraintName = `${className}_unique_${fieldNames.sort().join('_')}`;
    const constraintPatterns = fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `CREATE UNIQUE INDEX IF NOT EXISTS $2:name ON $1:name(${constraintPatterns.join()})`;
    return this._client.none(qs, [className, constraintName, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(constraintName)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(constraintName)) {
        // Cast the error into the proper parse error
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  }

  // Creates a unique index on authData-><provider>->>'id' to prevent
  // race conditions during concurrent signups with the same authData.
  async ensureAuthDataUniqueness(provider) {
    const indexName = `_User_unique_authData_${provider}_id`;
    const qs = `CREATE UNIQUE INDEX IF NOT EXISTS $1:name ON "_User" (("authData"->$2::text->>'id')) WHERE "authData"->$2::text->>'id' IS NOT NULL`;
    await this._client.none(qs, [indexName, provider]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(indexName)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(indexName)) {
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'Tried to ensure field uniqueness for a class that already has duplicates.');
      } else {
        throw error;
      }
    });
  }

  // Executes a count.
  async count(className, schema, query, readPreference, estimate = true) {
    debug('count');
    const values = [className];
    const where = buildWhereClause({
      schema,
      query,
      index: 2,
      caseInsensitive: false
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    let qs = '';
    if (where.pattern.length > 0 || !estimate) {
      qs = `SELECT count(*) FROM $1:name ${wherePattern}`;
    } else {
      qs = 'SELECT reltuples AS approximate_row_count FROM pg_class WHERE relname = $1';
    }
    return this._client.one(qs, values, a => {
      if (a.approximate_row_count == null || a.approximate_row_count == -1) {
        return !isNaN(+a.count) ? +a.count : 0;
      } else {
        return +a.approximate_row_count;
      }
    }).catch(error => {
      if (error.code !== PostgresRelationDoesNotExistError && error.code !== PostgresMissingColumnError) {
        throw error;
      }
      return 0;
    });
  }
  async distinct(className, schema, query, fieldName) {
    debug('distinct');
    const fieldSegments = fieldName.split('.');
    for (const segment of fieldSegments) {
      if (!segment.match(/^[a-zA-Z][a-zA-Z0-9_]*$/)) {
        throw new _node.default.Error(_node.default.Error.INVALID_KEY_NAME, `Invalid field name: ${fieldName}`);
      }
    }
    let field = fieldName;
    let column = fieldName;
    const isNested = fieldName.indexOf('.') >= 0;
    if (isNested) {
      field = transformDotFieldToComponents(fieldName).join('->');
      column = fieldSegments[0];
    }
    const isArrayField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Array';
    const isPointerField = schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Pointer';
    const values = [field, column, className];
    const where = buildWhereClause({
      schema,
      query,
      index: 4,
      caseInsensitive: false
    });
    values.push(...where.values);
    const wherePattern = where.pattern.length > 0 ? `WHERE ${where.pattern}` : '';
    const transformer = isArrayField ? 'jsonb_array_elements' : 'ON';
    let qs = `SELECT DISTINCT ${transformer}($1:name) $2:name FROM $3:name ${wherePattern}`;
    if (isNested) {
      qs = `SELECT DISTINCT ${transformer}($1:raw) $2:raw FROM $3:name ${wherePattern}`;
    }
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
  async aggregate(className, schema, pipeline, readPreference, hint, explain) {
    debug('aggregate');
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
              if (typeof value[alias] === 'string' && value[alias]) {
                const source = transformAggregateField(value[alias]);
                if (!groupByFields.includes(`"${source}"`)) {
                  groupByFields.push(`"${source}"`);
                }
                values.push(source, alias);
                columns.push(`$${index}:name AS $${index + 1}:name`);
                index += 2;
              } else {
                const operation = Object.keys(value[alias])[0];
                const source = transformAggregateField(value[alias][operation]);
                if (mongoAggregateToPostgres[operation]) {
                  if (!groupByFields.includes(`"${source}"`)) {
                    groupByFields.push(`"${source}"`);
                  }
                  columns.push(`EXTRACT(${mongoAggregateToPostgres[operation]} FROM $${index}:name AT TIME ZONE 'UTC')::integer AS $${index + 1}:name`);
                  values.push(source, alias);
                  index += 2;
                }
              }
            }
            groupPattern = `GROUP BY $${index}:raw`;
            values.push(groupByFields.join());
            index += 1;
            continue;
          }
          if (typeof value === 'object') {
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
        const orOrAnd = Object.prototype.hasOwnProperty.call(stage.$match, '$or') ? ' OR ' : ' AND ';
        if (stage.$match.$or) {
          const collapse = {};
          stage.$match.$or.forEach(element => {
            for (const key in element) {
              collapse[key] = element[key];
            }
          });
          stage.$match = collapse;
        }
        for (let field in stage.$match) {
          const value = stage.$match[field];
          if (field === '_id') {
            field = 'objectId';
          }
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
    if (groupPattern) {
      columns.forEach((e, i, a) => {
        if (e && e.trim() === '*') {
          a[i] = '';
        }
      });
    }
    const originalQuery = `SELECT ${columns.filter(Boolean).join()} FROM $1:name ${wherePattern} ${skipPattern} ${groupPattern} ${sortPattern} ${limitPattern}`;
    const qs = explain ? this.createExplainableQuery(originalQuery) : originalQuery;
    return this._client.any(qs, values).then(a => {
      if (explain) {
        return a;
      }
      const results = a.map(object => this.postgresObjectToParseObject(className, object, schema));
      results.forEach(result => {
        if (!Object.prototype.hasOwnProperty.call(result, 'objectId')) {
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
  async performInitialization({
    VolatileClassesSchemas
  }) {
    // TODO: This method needs to be rewritten to make proper use of connections (@vitaly-t)
    debug('performInitialization');
    await this._ensureSchemaCollectionExists();
    const promises = VolatileClassesSchemas.map(schema => {
      return this.createTable(schema.className, schema).catch(err => {
        if (err.code === PostgresDuplicateRelationError || err.code === _node.default.Error.INVALID_CLASS_NAME) {
          return Promise.resolve();
        }
        throw err;
      }).then(() => this.schemaUpgrade(schema.className, schema));
    });
    promises.push(this._listenToSchema());
    return Promise.all(promises).then(() => {
      return this._client.tx('perform-initialization', async t => {
        await t.none(_sql.default.misc.jsonObjectSetKeys);
        await t.none(_sql.default.array.add);
        await t.none(_sql.default.array.addUnique);
        await t.none(_sql.default.array.remove);
        await t.none(_sql.default.array.containsAll);
        await t.none(_sql.default.array.containsAllRegex);
        await t.none(_sql.default.array.contains);
        return t.ctx;
      });
    }).then(ctx => {
      debug(`initializationDone in ${ctx.duration}`);
    }).catch(error => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  }
  async createIndexes(className, indexes, conn) {
    return (conn || this._client).tx(t => t.batch(indexes.map(i => {
      return t.none('CREATE INDEX IF NOT EXISTS $1:name ON $2:name ($3:name)', [i.name, className, i.key]);
    })));
  }
  async createIndexesIfNeeded(className, fieldName, type, conn) {
    await (conn || this._client).none('CREATE INDEX IF NOT EXISTS $1:name ON $2:name ($3:name)', [fieldName, className, type]);
  }
  async dropIndexes(className, indexes, conn) {
    const queries = indexes.map(i => ({
      query: 'DROP INDEX $1:name',
      values: i
    }));
    await (conn || this._client).tx(t => t.none(this._pgp.helpers.concat(queries)));
  }
  async getIndexes(className) {
    const qs = 'SELECT * FROM pg_indexes WHERE tablename = ${className}';
    return this._client.any(qs, {
      className
    });
  }
  async updateSchemaWithIndexes() {
    return Promise.resolve();
  }

  // Used for testing purposes
  async updateEstimatedCount(className) {
    return this._client.none('ANALYZE $1:name', [className]);
  }
  async createTransactionalSession() {
    return new Promise(resolve => {
      const transactionalSession = {};
      transactionalSession.result = this._client.tx(t => {
        transactionalSession.t = t;
        transactionalSession.promise = new Promise(resolve => {
          transactionalSession.resolve = resolve;
        });
        transactionalSession.batch = [];
        resolve(transactionalSession);
        return transactionalSession.promise;
      });
    });
  }
  commitTransactionalSession(transactionalSession) {
    transactionalSession.resolve(transactionalSession.t.batch(transactionalSession.batch));
    return transactionalSession.result;
  }
  abortTransactionalSession(transactionalSession) {
    const result = transactionalSession.result.catch();
    transactionalSession.batch.push(Promise.reject());
    transactionalSession.resolve(transactionalSession.t.batch(transactionalSession.batch));
    return result;
  }
  async ensureIndex(className, schema, fieldNames, indexName, caseInsensitive = false, options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const defaultIndexName = `parse_default_${fieldNames.sort().join('_')}`;
    const indexNameOptions = indexName != null ? {
      name: indexName
    } : {
      name: defaultIndexName
    };
    const constraintPatterns = caseInsensitive ? fieldNames.map((fieldName, index) => `lower($${index + 3}:name) varchar_pattern_ops`) : fieldNames.map((fieldName, index) => `$${index + 3}:name`);
    const qs = `CREATE INDEX IF NOT EXISTS $1:name ON $2:name (${constraintPatterns.join()})`;
    const setIdempotencyFunction = options.setIdempotencyFunction !== undefined ? options.setIdempotencyFunction : false;
    if (setIdempotencyFunction) {
      await this.ensureIdempotencyFunctionExists(options);
    }
    await conn.none(qs, [indexNameOptions.name, className, ...fieldNames]).catch(error => {
      if (error.code === PostgresDuplicateRelationError && error.message.includes(indexNameOptions.name)) {
        // Index already exists. Ignore error.
      } else if (error.code === PostgresUniqueIndexViolationError && error.message.includes(indexNameOptions.name)) {
        // Cast the error into the proper parse error
        throw new _node.default.Error(_node.default.Error.DUPLICATE_VALUE, 'A duplicate value for a field with unique values was provided');
      } else {
        throw error;
      }
    });
  }
  async deleteIdempotencyFunction(options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const qs = 'DROP FUNCTION IF EXISTS idempotency_delete_expired_records()';
    return conn.none(qs).catch(error => {
      throw error;
    });
  }
  async ensureIdempotencyFunctionExists(options = {}) {
    const conn = options.conn !== undefined ? options.conn : this._client;
    const ttlOptions = options.ttl !== undefined ? `${options.ttl} seconds` : '60 seconds';
    const qs = 'CREATE OR REPLACE FUNCTION idempotency_delete_expired_records() RETURNS void LANGUAGE plpgsql AS $$ BEGIN DELETE FROM "_Idempotency" WHERE expire < NOW() - INTERVAL $1; END; $$;';
    return conn.none(qs, [ttlOptions]).catch(error => {
      throw error;
    });
  }
}
exports.PostgresStorageAdapter = PostgresStorageAdapter;
function convertPolygonToSQL(polygon) {
  if (polygon.length < 3) {
    throw new _node.default.Error(_node.default.Error.INVALID_JSON, `Polygon must have at least 3 values`);
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
    throw new _node.default.Error(_node.default.Error.INTERNAL_SERVER_ERROR, 'GeoJSON: Loop must have at least 3 different vertices');
  }
  const points = polygon.map(point => {
    _node.default.GeoPoint._validate(parseFloat(point[1]), parseFloat(point[0]));
    return `(${point[1]}, ${point[0]})`;
  }).join(', ');
  return `(${points})`;
}
function removeWhiteSpace(regex) {
  if (!regex.endsWith('\n')) {
    regex += '\n';
  }

  // remove non escaped comments
  return regex.replace(/([^\\])#.*\n/gim, '$1')
  // remove lines starting with a comment
  .replace(/^#.*\n/gim, '')
  // remove non escaped whitespace
  .replace(/([^\\])\s+/gim, '$1')
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
    const regex = RegExp('[0-9 ]|\\p{L}', 'u'); // Support all Unicode letter chars
    if (c.match(regex) !== null) {
      // Don't escape alphanumeric characters
      return c;
    }
    // Escape everything else (single quotes with single quotes, everything else with a backslash)
    return c === `'` ? `''` : `\\${c}`;
  }).join('');
}
function literalizeRegexPart(s) {
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);
  if (result1 && result1.length > 1 && result1.index > -1) {
    // Process Regex that has a beginning and an end specified for the literal text
    const prefix = s.substring(0, result1.index);
    const remaining = result1[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // Process Regex that has a beginning specified for the literal text
  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);
  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substring(0, result2.index);
    const remaining = result2[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }

  // Remove problematic chars from remaining text
  return s
  // Remove all instances of \Q and \E
  .replace(/([^\\])(\\E)/, '$1').replace(/([^\\])(\\Q)/, '$1').replace(/^\\E/, '').replace(/^\\Q/, '')
  // Ensure even number of single quote sequences by adding an extra single quote if needed;
  // this ensures that every single quote is escaped
  .replace(/'+/g, match => {
    return match.length % 2 === 0 ? match : match + "'";
  });
}
var GeoPointCoder = {
  isValidJSON(value) {
    return typeof value === 'object' && value !== null && value.__type === 'GeoPoint';
  }
};
var _default = exports.default = PostgresStorageAdapter;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJfUG9zdGdyZXNDbGllbnQiLCJyZXF1aXJlIiwiX25vZGUiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX2xvZGFzaCIsIl9jcnlwdG8iLCJfc3FsIiwiX1N0b3JhZ2VBZGFwdGVyIiwiZSIsIl9fZXNNb2R1bGUiLCJkZWZhdWx0IiwiVXRpbHMiLCJQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IiLCJQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IiLCJQb3N0Z3Jlc0R1cGxpY2F0ZUNvbHVtbkVycm9yIiwiUG9zdGdyZXNNaXNzaW5nQ29sdW1uRXJyb3IiLCJQb3N0Z3Jlc1VuaXF1ZUluZGV4VmlvbGF0aW9uRXJyb3IiLCJsb2dnZXIiLCJkZWJ1ZyIsImFyZ3MiLCJhcmd1bWVudHMiLCJjb25jYXQiLCJzbGljZSIsImxlbmd0aCIsImxvZyIsImdldExvZ2dlciIsImFwcGx5IiwicGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUiLCJ0eXBlIiwiY29udGVudHMiLCJKU09OIiwic3RyaW5naWZ5IiwiUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yIiwiJGd0IiwiJGx0IiwiJGd0ZSIsIiRsdGUiLCJtb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXMiLCIkZGF5T2ZNb250aCIsIiRkYXlPZldlZWsiLCIkZGF5T2ZZZWFyIiwiJGlzb0RheU9mV2VlayIsIiRpc29XZWVrWWVhciIsIiRob3VyIiwiJG1pbnV0ZSIsIiRzZWNvbmQiLCIkbWlsbGlzZWNvbmQiLCIkbW9udGgiLCIkd2VlayIsIiR5ZWFyIiwidG9Qb3N0Z3Jlc1ZhbHVlIiwidmFsdWUiLCJfX3R5cGUiLCJpc28iLCJuYW1lIiwidG9Qb3N0Z3Jlc1ZhbHVlQ2FzdFR5cGUiLCJwb3N0Z3Jlc1ZhbHVlIiwiY2FzdFR5cGUiLCJ1bmRlZmluZWQiLCJ0cmFuc2Zvcm1WYWx1ZSIsIm9iamVjdElkIiwiZW1wdHlDTFBTIiwiT2JqZWN0IiwiZnJlZXplIiwiZmluZCIsImdldCIsImNvdW50IiwiY3JlYXRlIiwidXBkYXRlIiwiZGVsZXRlIiwiYWRkRmllbGQiLCJwcm90ZWN0ZWRGaWVsZHMiLCJkZWZhdWx0Q0xQUyIsIkFDTCIsInJlYWQiLCJ3cml0ZSIsInRvUGFyc2VTY2hlbWEiLCJzY2hlbWEiLCJjbGFzc05hbWUiLCJmaWVsZHMiLCJfaGFzaGVkX3Bhc3N3b3JkIiwiX3dwZXJtIiwiX3JwZXJtIiwiY2xwcyIsImNsYXNzTGV2ZWxQZXJtaXNzaW9ucyIsImluZGV4ZXMiLCJ0b1Bvc3RncmVzU2NoZW1hIiwiX3Bhc3N3b3JkX2hpc3RvcnkiLCJpc0FycmF5SW5kZXgiLCJhcnJheUluZGV4IiwiQXJyYXkiLCJmcm9tIiwiZXZlcnkiLCJjIiwiaGFuZGxlRG90RmllbGRzIiwib2JqZWN0Iiwia2V5cyIsImZvckVhY2giLCJmaWVsZE5hbWUiLCJpbmRleE9mIiwiY29tcG9uZW50cyIsInNwbGl0IiwiZmlyc3QiLCJzaGlmdCIsImhhc093biIsImN1cnJlbnRPYmoiLCJuZXh0IiwiX19vcCIsImVzY2FwZVNxbFN0cmluZyIsInJlcGxhY2UiLCJlc2NhcGVKc29uU3RyaW5nIiwidHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMiLCJtYXAiLCJjbXB0IiwiaW5kZXgiLCJOdW1iZXIiLCJ0cmFuc2Zvcm1Eb3RGaWVsZCIsImpvaW4iLCJ2YWxpZGF0ZUFnZ3JlZ2F0ZUZpZWxkTmFtZSIsIm1hdGNoIiwiUGFyc2UiLCJFcnJvciIsIklOVkFMSURfS0VZX05BTUUiLCJ0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCIsInN0YXJ0c1dpdGgiLCJzdWJzdHJpbmciLCJ2YWxpZGF0ZUtleXMiLCJrZXkiLCJpbmNsdWRlcyIsIklOVkFMSURfTkVTVEVEX0tFWSIsImpvaW5UYWJsZXNGb3JTY2hlbWEiLCJsaXN0IiwiZmllbGQiLCJwdXNoIiwiYnVpbGRXaGVyZUNsYXVzZSIsInF1ZXJ5IiwiY2FzZUluc2Vuc2l0aXZlIiwicGF0dGVybnMiLCJ2YWx1ZXMiLCJzb3J0cyIsImlzQXJyYXlGaWVsZCIsImluaXRpYWxQYXR0ZXJuc0xlbmd0aCIsImZpZWxkVmFsdWUiLCIkZXhpc3RzIiwiYXV0aERhdGFNYXRjaCIsIiRpbiIsIiRyZWdleCIsInNvbWUiLCJNQVhfSU5UX1BMVVNfT05FIiwiY2xhdXNlcyIsImNsYXVzZVZhbHVlcyIsInN1YlF1ZXJ5IiwiY2xhdXNlIiwicGF0dGVybiIsIm9yT3JBbmQiLCJub3QiLCIkbmUiLCJjb25zdHJhaW50RmllbGROYW1lIiwiJHJlbGF0aXZlVGltZSIsIklOVkFMSURfSlNPTiIsInBvaW50IiwibG9uZ2l0dWRlIiwibGF0aXR1ZGUiLCIkZXEiLCJpc0luT3JOaW4iLCJpc0FycmF5IiwiJG5pbiIsImluUGF0dGVybnMiLCJhbGxvd051bGwiLCJsaXN0RWxlbSIsImxpc3RJbmRleCIsImNyZWF0ZUNvbnN0cmFpbnQiLCJiYXNlQXJyYXkiLCJub3RJbiIsImZpZWxkVHlwZSIsIm9wZXJhdG9yTmFtZSIsImVsZW0iLCJJTlZBTElEX1FVRVJZIiwiXyIsImZsYXRNYXAiLCJlbHQiLCIkYWxsIiwiaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aCIsImlzQWxsVmFsdWVzUmVnZXhPck5vbmUiLCJpIiwicHJvY2Vzc1JlZ2V4UGF0dGVybiIsIiRjb250YWluZWRCeSIsImFyciIsIiR0ZXh0Iiwic2VhcmNoIiwiJHNlYXJjaCIsImxhbmd1YWdlIiwiJHRlcm0iLCIkbGFuZ3VhZ2UiLCIkY2FzZVNlbnNpdGl2ZSIsIiRkaWFjcml0aWNTZW5zaXRpdmUiLCIkbmVhclNwaGVyZSIsImRpc3RhbmNlIiwiJG1heERpc3RhbmNlIiwiZGlzdGFuY2VJbktNIiwiJHdpdGhpbiIsIiRib3giLCJib3giLCJsZWZ0IiwiYm90dG9tIiwicmlnaHQiLCJ0b3AiLCIkZ2VvV2l0aGluIiwiJGNlbnRlclNwaGVyZSIsImNlbnRlclNwaGVyZSIsIkdlb1BvaW50IiwiR2VvUG9pbnRDb2RlciIsImlzVmFsaWRKU09OIiwiX3ZhbGlkYXRlIiwiaXNOYU4iLCIkcG9seWdvbiIsInBvbHlnb24iLCJwb2ludHMiLCJjb29yZGluYXRlcyIsIiRnZW9JbnRlcnNlY3RzIiwiJHBvaW50IiwicmVnZXgiLCJvcGVyYXRvciIsIm9wdHMiLCIkb3B0aW9ucyIsInJlbW92ZVdoaXRlU3BhY2UiLCJjb252ZXJ0UG9seWdvblRvU1FMIiwiY21wIiwicGdDb21wYXJhdG9yIiwicGFyc2VyUmVzdWx0IiwicmVsYXRpdmVUaW1lVG9EYXRlIiwic3RhdHVzIiwicmVzdWx0IiwiY29uc29sZSIsImVycm9yIiwiaW5mbyIsIk9QRVJBVElPTl9GT1JCSURERU4iLCJQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyIiwiY29uc3RydWN0b3IiLCJ1cmkiLCJjb2xsZWN0aW9uUHJlZml4IiwiZGF0YWJhc2VPcHRpb25zIiwib3B0aW9ucyIsIl9jb2xsZWN0aW9uUHJlZml4IiwiZW5hYmxlU2NoZW1hSG9va3MiLCJkaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb24iLCJzY2hlbWFDYWNoZVR0bCIsImNsaWVudCIsInBncCIsImNyZWF0ZUNsaWVudCIsIl9jbGllbnQiLCJfb25jaGFuZ2UiLCJfcGdwIiwiX3V1aWQiLCJyYW5kb21VVUlEIiwiY2FuU29ydE9uSm9pblRhYmxlcyIsIndhdGNoIiwiY2FsbGJhY2siLCJjcmVhdGVFeHBsYWluYWJsZVF1ZXJ5IiwiYW5hbHl6ZSIsImhhbmRsZVNodXRkb3duIiwiX3N0cmVhbSIsImRvbmUiLCIkcG9vbCIsImVuZCIsIl9saXN0ZW5Ub1NjaGVtYSIsImNvbm5lY3QiLCJkaXJlY3QiLCJvbiIsImRhdGEiLCJwYXlsb2FkIiwicGFyc2UiLCJzZW5kZXJJZCIsIm5vbmUiLCJfbm90aWZ5U2NoZW1hQ2hhbmdlIiwiY2F0Y2giLCJfZW5zdXJlU2NoZW1hQ29sbGVjdGlvbkV4aXN0cyIsImNvbm4iLCJjbGFzc0V4aXN0cyIsIm9uZSIsImEiLCJleGlzdHMiLCJzZXRDbGFzc0xldmVsUGVybWlzc2lvbnMiLCJDTFBzIiwidGFzayIsInQiLCJzZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdCIsInN1Ym1pdHRlZEluZGV4ZXMiLCJleGlzdGluZ0luZGV4ZXMiLCJzZWxmIiwiUHJvbWlzZSIsInJlc29sdmUiLCJfaWRfIiwiX2lkIiwiZGVsZXRlZEluZGV4ZXMiLCJpbnNlcnRlZEluZGV4ZXMiLCJwcm90b3R5cGUiLCJoYXNPd25Qcm9wZXJ0eSIsImNhbGwiLCJ0eCIsImNyZWF0ZUluZGV4ZXMiLCJjb2x1bW5Eb2VzTm90RXhpc3RFcnJvciIsImdldEVycm9ycyIsImNvZGUiLCJkcm9wSW5kZXhlcyIsImNyZWF0ZUNsYXNzIiwicGFyc2VTY2hlbWEiLCJjcmVhdGVUYWJsZSIsImVyciIsImRldGFpbCIsIkRVUExJQ0FURV9WQUxVRSIsInZhbHVlc0FycmF5IiwicGF0dGVybnNBcnJheSIsImFzc2lnbiIsIl9lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCIsIl9lbWFpbF92ZXJpZnlfdG9rZW4iLCJfYWNjb3VudF9sb2Nrb3V0X2V4cGlyZXNfYXQiLCJfZmFpbGVkX2xvZ2luX2NvdW50IiwiX3BlcmlzaGFibGVfdG9rZW4iLCJfcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0IiwiX3Bhc3N3b3JkX2NoYW5nZWRfYXQiLCJyZWxhdGlvbnMiLCJwYXJzZVR5cGUiLCJxcyIsImJhdGNoIiwiam9pblRhYmxlIiwic2NoZW1hVXBncmFkZSIsImNvbHVtbnMiLCJjb2x1bW5fbmFtZSIsIm5ld0NvbHVtbnMiLCJmaWx0ZXIiLCJpdGVtIiwiYWRkRmllbGRJZk5vdEV4aXN0cyIsInBvc3RncmVzVHlwZSIsImFueSIsInBhdGgiLCJ1cGRhdGVGaWVsZE9wdGlvbnMiLCJkZWxldGVDbGFzcyIsIm9wZXJhdGlvbnMiLCJyZXNwb25zZSIsImhlbHBlcnMiLCJ0aGVuIiwiZGVsZXRlQWxsQ2xhc3NlcyIsIm5vdyIsIkRhdGUiLCJnZXRUaW1lIiwiZW5kZWQiLCJyZXN1bHRzIiwiam9pbnMiLCJyZWR1Y2UiLCJjbGFzc2VzIiwicXVlcmllcyIsImRlbGV0ZUZpZWxkcyIsImZpZWxkTmFtZXMiLCJpZHgiLCJnZXRBbGxDbGFzc2VzIiwicm93IiwiZ2V0Q2xhc3MiLCJjcmVhdGVPYmplY3QiLCJ0cmFuc2FjdGlvbmFsU2Vzc2lvbiIsImNvbHVtbnNBcnJheSIsImdlb1BvaW50cyIsImF1dGhEYXRhQWxyZWFkeUV4aXN0cyIsImF1dGhEYXRhIiwicHJvdmlkZXIiLCJwb3AiLCJpbml0aWFsVmFsdWVzIiwidmFsIiwidGVybWluYXRpb24iLCJnZW9Qb2ludHNJbmplY3RzIiwibCIsImNvbHVtbnNQYXR0ZXJuIiwiY29sIiwidmFsdWVzUGF0dGVybiIsInByb21pc2UiLCJvcHMiLCJ1bmRlcmx5aW5nRXJyb3IiLCJjb25zdHJhaW50IiwidXNlckluZm8iLCJkdXBsaWNhdGVkX2ZpZWxkIiwibWF0Y2hlcyIsImRlbGV0ZU9iamVjdHNCeVF1ZXJ5Iiwid2hlcmUiLCJPQkpFQ1RfTk9UX0ZPVU5EIiwiZmluZE9uZUFuZFVwZGF0ZSIsInVwZGF0ZU9iamVjdHNCeVF1ZXJ5IiwidXBkYXRlUGF0dGVybnMiLCJvcmlnaW5hbFVwZGF0ZSIsImRvdE5vdGF0aW9uT3B0aW9ucyIsImdlbmVyYXRlIiwianNvbmIiLCJnZW5lcmF0ZVJlbW92ZSIsImxhc3RLZXkiLCJmaWVsZE5hbWVJbmRleCIsInN0ciIsImFtb3VudCIsIm9iamVjdHMiLCJpc0RhdGUiLCJrZXlzVG9JbmNyZW1lbnQiLCJrIiwiaW5jcmVtZW50UGF0dGVybnMiLCJpbmNyZW1lbnRWYWx1ZXMiLCJhbW91bnRJbmRleCIsImpzb25TYWZlTmFtZSIsInNxbFNhZmVOYW1lIiwia2V5c1RvRGVsZXRlIiwiZGVsZXRlUGF0dGVybnMiLCJwIiwidXBkYXRlT2JqZWN0IiwiZXhwZWN0ZWRUeXBlIiwicmVqZWN0Iiwid2hlcmVDbGF1c2UiLCJ1cHNlcnRPbmVPYmplY3QiLCJjcmVhdGVWYWx1ZSIsInNraXAiLCJsaW1pdCIsInNvcnQiLCJleHBsYWluIiwiaGFzTGltaXQiLCJoYXNTa2lwIiwid2hlcmVQYXR0ZXJuIiwibGltaXRQYXR0ZXJuIiwic2tpcFBhdHRlcm4iLCJzb3J0UGF0dGVybiIsInNvcnRDb3B5Iiwic29ydGluZyIsInRyYW5zZm9ybUtleSIsIm1lbW8iLCJvcmlnaW5hbFF1ZXJ5IiwicG9zdGdyZXNPYmplY3RUb1BhcnNlT2JqZWN0IiwidGFyZ2V0Q2xhc3MiLCJ5IiwieCIsImNvb3JkcyIsIlN0cmluZyIsInVwZGF0ZWRDb29yZHMiLCJwYXJzZUZsb2F0IiwiY3JlYXRlZEF0IiwidG9JU09TdHJpbmciLCJ1cGRhdGVkQXQiLCJleHBpcmVzQXQiLCJlbnN1cmVVbmlxdWVuZXNzIiwiY29uc3RyYWludE5hbWUiLCJjb25zdHJhaW50UGF0dGVybnMiLCJtZXNzYWdlIiwiZW5zdXJlQXV0aERhdGFVbmlxdWVuZXNzIiwiaW5kZXhOYW1lIiwicmVhZFByZWZlcmVuY2UiLCJlc3RpbWF0ZSIsImFwcHJveGltYXRlX3Jvd19jb3VudCIsImRpc3RpbmN0IiwiZmllbGRTZWdtZW50cyIsInNlZ21lbnQiLCJjb2x1bW4iLCJpc05lc3RlZCIsImlzUG9pbnRlckZpZWxkIiwidHJhbnNmb3JtZXIiLCJjaGlsZCIsImFnZ3JlZ2F0ZSIsInBpcGVsaW5lIiwiaGludCIsImNvdW50RmllbGQiLCJncm91cFZhbHVlcyIsImdyb3VwUGF0dGVybiIsInN0YWdlIiwiJGdyb3VwIiwiZ3JvdXBCeUZpZWxkcyIsImFsaWFzIiwic291cmNlIiwib3BlcmF0aW9uIiwiJHN1bSIsIiRtYXgiLCIkbWluIiwiJGF2ZyIsIiRwcm9qZWN0IiwiJG1hdGNoIiwiJG9yIiwiY29sbGFwc2UiLCJlbGVtZW50IiwibWF0Y2hQYXR0ZXJucyIsIiRsaW1pdCIsIiRza2lwIiwiJHNvcnQiLCJvcmRlciIsInRyaW0iLCJCb29sZWFuIiwicGFyc2VJbnQiLCJwZXJmb3JtSW5pdGlhbGl6YXRpb24iLCJWb2xhdGlsZUNsYXNzZXNTY2hlbWFzIiwicHJvbWlzZXMiLCJJTlZBTElEX0NMQVNTX05BTUUiLCJhbGwiLCJzcWwiLCJtaXNjIiwianNvbk9iamVjdFNldEtleXMiLCJhcnJheSIsImFkZCIsImFkZFVuaXF1ZSIsInJlbW92ZSIsImNvbnRhaW5zQWxsIiwiY29udGFpbnNBbGxSZWdleCIsImNvbnRhaW5zIiwiY3R4IiwiZHVyYXRpb24iLCJjcmVhdGVJbmRleGVzSWZOZWVkZWQiLCJnZXRJbmRleGVzIiwidXBkYXRlU2NoZW1hV2l0aEluZGV4ZXMiLCJ1cGRhdGVFc3RpbWF0ZWRDb3VudCIsImNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24iLCJhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uIiwiZW5zdXJlSW5kZXgiLCJkZWZhdWx0SW5kZXhOYW1lIiwiaW5kZXhOYW1lT3B0aW9ucyIsInNldElkZW1wb3RlbmN5RnVuY3Rpb24iLCJlbnN1cmVJZGVtcG90ZW5jeUZ1bmN0aW9uRXhpc3RzIiwiZGVsZXRlSWRlbXBvdGVuY3lGdW5jdGlvbiIsInR0bE9wdGlvbnMiLCJ0dGwiLCJleHBvcnRzIiwidW5pcXVlIiwiYXIiLCJmb3VuZEluZGV4IiwicHQiLCJJTlRFUk5BTF9TRVJWRVJfRVJST1IiLCJlbmRzV2l0aCIsInMiLCJsaXRlcmFsaXplUmVnZXhQYXJ0IiwiaXNTdGFydHNXaXRoUmVnZXgiLCJmaXJzdFZhbHVlc0lzUmVnZXgiLCJjcmVhdGVMaXRlcmFsUmVnZXgiLCJyZW1haW5pbmciLCJSZWdFeHAiLCJtYXRjaGVyMSIsInJlc3VsdDEiLCJwcmVmaXgiLCJtYXRjaGVyMiIsInJlc3VsdDIiLCJfZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9BZGFwdGVycy9TdG9yYWdlL1Bvc3RncmVzL1Bvc3RncmVzU3RvcmFnZUFkYXB0ZXIuanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8gQGZsb3dcbmltcG9ydCB7IGNyZWF0ZUNsaWVudCB9IGZyb20gJy4vUG9zdGdyZXNDbGllbnQnO1xuLy8gQGZsb3ctZGlzYWJsZS1uZXh0XG5pbXBvcnQgUGFyc2UgZnJvbSAncGFyc2Uvbm9kZSc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCBfIGZyb20gJ2xvZGFzaCc7XG4vLyBAZmxvdy1kaXNhYmxlLW5leHRcbmltcG9ydCB7IHJhbmRvbVVVSUQgfSBmcm9tICdjcnlwdG8nO1xuaW1wb3J0IHNxbCBmcm9tICcuL3NxbCc7XG5pbXBvcnQgeyBTdG9yYWdlQWRhcHRlciB9IGZyb20gJy4uL1N0b3JhZ2VBZGFwdGVyJztcbmltcG9ydCB0eXBlIHsgU2NoZW1hVHlwZSwgUXVlcnlUeXBlLCBRdWVyeU9wdGlvbnMgfSBmcm9tICcuLi9TdG9yYWdlQWRhcHRlcic7XG5jb25zdCBVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL1V0aWxzJyk7XG5cbmNvbnN0IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvciA9ICc0MlAwMSc7XG5jb25zdCBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgPSAnNDJQMDcnO1xuY29uc3QgUG9zdGdyZXNEdXBsaWNhdGVDb2x1bW5FcnJvciA9ICc0MjcwMSc7XG5jb25zdCBQb3N0Z3Jlc01pc3NpbmdDb2x1bW5FcnJvciA9ICc0MjcwMyc7XG5jb25zdCBQb3N0Z3Jlc1VuaXF1ZUluZGV4VmlvbGF0aW9uRXJyb3IgPSAnMjM1MDUnO1xuY29uc3QgbG9nZ2VyID0gcmVxdWlyZSgnLi4vLi4vLi4vbG9nZ2VyJyk7XG5cbmNvbnN0IGRlYnVnID0gZnVuY3Rpb24gKC4uLmFyZ3M6IGFueSkge1xuICBhcmdzID0gWydQRzogJyArIGFyZ3VtZW50c1swXV0uY29uY2F0KGFyZ3Muc2xpY2UoMSwgYXJncy5sZW5ndGgpKTtcbiAgY29uc3QgbG9nID0gbG9nZ2VyLmdldExvZ2dlcigpO1xuICBsb2cuZGVidWcuYXBwbHkobG9nLCBhcmdzKTtcbn07XG5cbmNvbnN0IHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlID0gdHlwZSA9PiB7XG4gIHN3aXRjaCAodHlwZS50eXBlKSB7XG4gICAgY2FzZSAnU3RyaW5nJzpcbiAgICAgIHJldHVybiAndGV4dCc7XG4gICAgY2FzZSAnRGF0ZSc6XG4gICAgICByZXR1cm4gJ3RpbWVzdGFtcCB3aXRoIHRpbWUgem9uZSc7XG4gICAgY2FzZSAnT2JqZWN0JzpcbiAgICAgIHJldHVybiAnanNvbmInO1xuICAgIGNhc2UgJ0ZpbGUnOlxuICAgICAgcmV0dXJuICd0ZXh0JztcbiAgICBjYXNlICdCb29sZWFuJzpcbiAgICAgIHJldHVybiAnYm9vbGVhbic7XG4gICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICByZXR1cm4gJ3RleHQnO1xuICAgIGNhc2UgJ051bWJlcic6XG4gICAgICByZXR1cm4gJ2RvdWJsZSBwcmVjaXNpb24nO1xuICAgIGNhc2UgJ0dlb1BvaW50JzpcbiAgICAgIHJldHVybiAncG9pbnQnO1xuICAgIGNhc2UgJ0J5dGVzJzpcbiAgICAgIHJldHVybiAnanNvbmInO1xuICAgIGNhc2UgJ1BvbHlnb24nOlxuICAgICAgcmV0dXJuICdwb2x5Z29uJztcbiAgICBjYXNlICdBcnJheSc6XG4gICAgICBpZiAodHlwZS5jb250ZW50cyAmJiB0eXBlLmNvbnRlbnRzLnR5cGUgPT09ICdTdHJpbmcnKSB7XG4gICAgICAgIHJldHVybiAndGV4dFtdJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiAnanNvbmInO1xuICAgICAgfVxuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBgbm8gdHlwZSBmb3IgJHtKU09OLnN0cmluZ2lmeSh0eXBlKX0geWV0YDtcbiAgfVxufTtcblxuY29uc3QgUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yID0ge1xuICAkZ3Q6ICc+JyxcbiAgJGx0OiAnPCcsXG4gICRndGU6ICc+PScsXG4gICRsdGU6ICc8PScsXG59O1xuXG5jb25zdCBtb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXMgPSB7XG4gICRkYXlPZk1vbnRoOiAnREFZJyxcbiAgJGRheU9mV2VlazogJ0RPVycsXG4gICRkYXlPZlllYXI6ICdET1knLFxuICAkaXNvRGF5T2ZXZWVrOiAnSVNPRE9XJyxcbiAgJGlzb1dlZWtZZWFyOiAnSVNPWUVBUicsXG4gICRob3VyOiAnSE9VUicsXG4gICRtaW51dGU6ICdNSU5VVEUnLFxuICAkc2Vjb25kOiAnU0VDT05EJyxcbiAgJG1pbGxpc2Vjb25kOiAnTUlMTElTRUNPTkRTJyxcbiAgJG1vbnRoOiAnTU9OVEgnLFxuICAkd2VlazogJ1dFRUsnLFxuICAkeWVhcjogJ1lFQVInLFxufTtcblxuY29uc3QgdG9Qb3N0Z3Jlc1ZhbHVlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgIGlmICh2YWx1ZS5fX3R5cGUgPT09ICdEYXRlJykge1xuICAgICAgcmV0dXJuIHZhbHVlLmlzbztcbiAgICB9XG4gICAgaWYgKHZhbHVlLl9fdHlwZSA9PT0gJ0ZpbGUnKSB7XG4gICAgICByZXR1cm4gdmFsdWUubmFtZTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufTtcblxuY29uc3QgdG9Qb3N0Z3Jlc1ZhbHVlQ2FzdFR5cGUgPSB2YWx1ZSA9PiB7XG4gIGNvbnN0IHBvc3RncmVzVmFsdWUgPSB0b1Bvc3RncmVzVmFsdWUodmFsdWUpO1xuICBsZXQgY2FzdFR5cGU7XG4gIHN3aXRjaCAodHlwZW9mIHBvc3RncmVzVmFsdWUpIHtcbiAgICBjYXNlICdudW1iZXInOlxuICAgICAgY2FzdFR5cGUgPSAnZG91YmxlIHByZWNpc2lvbic7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdib29sZWFuJzpcbiAgICAgIGNhc3RUeXBlID0gJ2Jvb2xlYW4nO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIGNhc3RUeXBlID0gdW5kZWZpbmVkO1xuICB9XG4gIHJldHVybiBjYXN0VHlwZTtcbn07XG5cbmNvbnN0IHRyYW5zZm9ybVZhbHVlID0gdmFsdWUgPT4ge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgIHJldHVybiB2YWx1ZS5vYmplY3RJZDtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59O1xuXG4vLyBEdXBsaWNhdGUgZnJvbSB0aGVuIG1vbmdvIGFkYXB0ZXIuLi5cbmNvbnN0IGVtcHR5Q0xQUyA9IE9iamVjdC5mcmVlemUoe1xuICBmaW5kOiB7fSxcbiAgZ2V0OiB7fSxcbiAgY291bnQ6IHt9LFxuICBjcmVhdGU6IHt9LFxuICB1cGRhdGU6IHt9LFxuICBkZWxldGU6IHt9LFxuICBhZGRGaWVsZDoge30sXG4gIHByb3RlY3RlZEZpZWxkczoge30sXG59KTtcblxuY29uc3QgZGVmYXVsdENMUFMgPSBPYmplY3QuZnJlZXplKHtcbiAgQUNMOiB7XG4gICAgJyonOiB7XG4gICAgICByZWFkOiB0cnVlLFxuICAgICAgd3JpdGU6IHRydWUsXG4gICAgfSxcbiAgfSxcbiAgZmluZDogeyAnKic6IHRydWUgfSxcbiAgZ2V0OiB7ICcqJzogdHJ1ZSB9LFxuICBjb3VudDogeyAnKic6IHRydWUgfSxcbiAgY3JlYXRlOiB7ICcqJzogdHJ1ZSB9LFxuICB1cGRhdGU6IHsgJyonOiB0cnVlIH0sXG4gIGRlbGV0ZTogeyAnKic6IHRydWUgfSxcbiAgYWRkRmllbGQ6IHsgJyonOiB0cnVlIH0sXG4gIHByb3RlY3RlZEZpZWxkczogeyAnKic6IFtdIH0sXG59KTtcblxuY29uc3QgdG9QYXJzZVNjaGVtYSA9IHNjaGVtYSA9PiB7XG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgZGVsZXRlIHNjaGVtYS5maWVsZHMuX2hhc2hlZF9wYXNzd29yZDtcbiAgfVxuICBpZiAoc2NoZW1hLmZpZWxkcykge1xuICAgIGRlbGV0ZSBzY2hlbWEuZmllbGRzLl93cGVybTtcbiAgICBkZWxldGUgc2NoZW1hLmZpZWxkcy5fcnBlcm07XG4gIH1cbiAgbGV0IGNscHMgPSBkZWZhdWx0Q0xQUztcbiAgaWYgKHNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMpIHtcbiAgICBjbHBzID0geyAuLi5lbXB0eUNMUFMsIC4uLnNjaGVtYS5jbGFzc0xldmVsUGVybWlzc2lvbnMgfTtcbiAgfVxuICBsZXQgaW5kZXhlcyA9IHt9O1xuICBpZiAoc2NoZW1hLmluZGV4ZXMpIHtcbiAgICBpbmRleGVzID0geyAuLi5zY2hlbWEuaW5kZXhlcyB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgY2xhc3NOYW1lOiBzY2hlbWEuY2xhc3NOYW1lLFxuICAgIGZpZWxkczogc2NoZW1hLmZpZWxkcyxcbiAgICBjbGFzc0xldmVsUGVybWlzc2lvbnM6IGNscHMsXG4gICAgaW5kZXhlcyxcbiAgfTtcbn07XG5cbmNvbnN0IHRvUG9zdGdyZXNTY2hlbWEgPSBzY2hlbWEgPT4ge1xuICBpZiAoIXNjaGVtYSkge1xuICAgIHJldHVybiBzY2hlbWE7XG4gIH1cbiAgc2NoZW1hLmZpZWxkcyA9IHNjaGVtYS5maWVsZHMgfHwge307XG4gIHNjaGVtYS5maWVsZHMuX3dwZXJtID0geyB0eXBlOiAnQXJyYXknLCBjb250ZW50czogeyB0eXBlOiAnU3RyaW5nJyB9IH07XG4gIHNjaGVtYS5maWVsZHMuX3JwZXJtID0geyB0eXBlOiAnQXJyYXknLCBjb250ZW50czogeyB0eXBlOiAnU3RyaW5nJyB9IH07XG4gIGlmIChzY2hlbWEuY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgc2NoZW1hLmZpZWxkcy5faGFzaGVkX3Bhc3N3b3JkID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgIHNjaGVtYS5maWVsZHMuX3Bhc3N3b3JkX2hpc3RvcnkgPSB7IHR5cGU6ICdBcnJheScgfTtcbiAgfVxuICByZXR1cm4gc2NoZW1hO1xufTtcblxuY29uc3QgaXNBcnJheUluZGV4ID0gKGFycmF5SW5kZXgpID0+IEFycmF5LmZyb20oYXJyYXlJbmRleCkuZXZlcnkoYyA9PiBjID49ICcwJyAmJiBjIDw9ICc5Jyk7XG5cbmNvbnN0IGhhbmRsZURvdEZpZWxkcyA9IG9iamVjdCA9PiB7XG4gIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgIGNvbnN0IGNvbXBvbmVudHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgIGNvbnN0IGZpcnN0ID0gY29tcG9uZW50cy5zaGlmdCgpO1xuICAgICAgLy8gT25seSBkZXNjZW5kIGludG8gYW4gb3duIG9iamVjdCwgbmV2ZXIgYW4gaW5oZXJpdGVkIHByb3RvdHlwZSBtZW1iZXJcbiAgICAgIG9iamVjdFtmaXJzdF0gPVxuICAgICAgICBPYmplY3QuaGFzT3duKG9iamVjdCwgZmlyc3QpICYmIG9iamVjdFtmaXJzdF0gJiYgdHlwZW9mIG9iamVjdFtmaXJzdF0gPT09ICdvYmplY3QnXG4gICAgICAgICAgPyBvYmplY3RbZmlyc3RdXG4gICAgICAgICAgOiB7fTtcbiAgICAgIGxldCBjdXJyZW50T2JqID0gb2JqZWN0W2ZpcnN0XTtcbiAgICAgIGxldCBuZXh0O1xuICAgICAgbGV0IHZhbHVlID0gb2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgICBpZiAodmFsdWUgJiYgdmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdmFsdWUgPSB1bmRlZmluZWQ7XG4gICAgICB9XG4gICAgICB3aGlsZSAoKG5leHQgPSBjb21wb25lbnRzLnNoaWZ0KCkpKSB7XG4gICAgICAgIGlmIChjb21wb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIGN1cnJlbnRPYmpbbmV4dF0gPSB2YWx1ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjdXJyZW50T2JqW25leHRdID1cbiAgICAgICAgICAgIE9iamVjdC5oYXNPd24oY3VycmVudE9iaiwgbmV4dCkgJiYgY3VycmVudE9ialtuZXh0XSAmJiB0eXBlb2YgY3VycmVudE9ialtuZXh0XSA9PT0gJ29iamVjdCdcbiAgICAgICAgICAgICAgPyBjdXJyZW50T2JqW25leHRdXG4gICAgICAgICAgICAgIDoge307XG4gICAgICAgICAgY3VycmVudE9iaiA9IGN1cnJlbnRPYmpbbmV4dF07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGRlbGV0ZSBvYmplY3RbZmllbGROYW1lXTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gb2JqZWN0O1xufTtcblxuY29uc3QgZXNjYXBlU3FsU3RyaW5nID0gdmFsdWUgPT4gdmFsdWUucmVwbGFjZSgvJy9nLCBcIicnXCIpO1xuY29uc3QgZXNjYXBlSnNvblN0cmluZyA9IHZhbHVlID0+IEpTT04uc3RyaW5naWZ5KHZhbHVlKS5zbGljZSgxLCAtMSk7XG5cbmNvbnN0IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzID0gZmllbGROYW1lID0+IHtcbiAgcmV0dXJuIGZpZWxkTmFtZS5zcGxpdCgnLicpLm1hcCgoY21wdCwgaW5kZXgpID0+IHtcbiAgICBpZiAoaW5kZXggPT09IDApIHtcbiAgICAgIHJldHVybiBgXCIke2NtcHQucmVwbGFjZSgvXCIvZywgJ1wiXCInKX1cImA7XG4gICAgfVxuICAgIGlmIChpc0FycmF5SW5kZXgoY21wdCkpIHtcbiAgICAgIHJldHVybiBOdW1iZXIoY21wdCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBgJyR7ZXNjYXBlU3FsU3RyaW5nKGNtcHQpfSdgO1xuICAgIH1cbiAgfSk7XG59O1xuXG5jb25zdCB0cmFuc2Zvcm1Eb3RGaWVsZCA9IGZpZWxkTmFtZSA9PiB7XG4gIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID09PSAtMSkge1xuICAgIHJldHVybiBgXCIke2ZpZWxkTmFtZS5yZXBsYWNlKC9cIi9nLCAnXCJcIicpfVwiYDtcbiAgfVxuICBjb25zdCBjb21wb25lbnRzID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKTtcbiAgbGV0IG5hbWUgPSBjb21wb25lbnRzLnNsaWNlKDAsIGNvbXBvbmVudHMubGVuZ3RoIC0gMSkuam9pbignLT4nKTtcbiAgbmFtZSArPSAnLT4+JyArIGNvbXBvbmVudHNbY29tcG9uZW50cy5sZW5ndGggLSAxXTtcbiAgcmV0dXJuIG5hbWU7XG59O1xuXG5jb25zdCB2YWxpZGF0ZUFnZ3JlZ2F0ZUZpZWxkTmFtZSA9IG5hbWUgPT4ge1xuICBpZiAodHlwZW9mIG5hbWUgIT09ICdzdHJpbmcnIHx8ICFuYW1lLm1hdGNoKC9eW2EtekEtWl1bYS16QS1aMC05X10qJC8pKSB7XG4gICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfS0VZX05BTUUsIGBJbnZhbGlkIGZpZWxkIG5hbWU6ICR7bmFtZX1gKTtcbiAgfVxufTtcblxuY29uc3QgdHJhbnNmb3JtQWdncmVnYXRlRmllbGQgPSBmaWVsZE5hbWUgPT4ge1xuICBpZiAodHlwZW9mIGZpZWxkTmFtZSAhPT0gJ3N0cmluZycpIHtcbiAgICByZXR1cm4gZmllbGROYW1lO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX2NyZWF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICdjcmVhdGVkQXQnO1xuICB9XG4gIGlmIChmaWVsZE5hbWUgPT09ICckX3VwZGF0ZWRfYXQnKSB7XG4gICAgcmV0dXJuICd1cGRhdGVkQXQnO1xuICB9XG4gIGlmICghZmllbGROYW1lLnN0YXJ0c1dpdGgoJyQnKSkge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgSW52YWxpZCBmaWVsZCBuYW1lOiAke2ZpZWxkTmFtZX1gKTtcbiAgfVxuICBjb25zdCBuYW1lID0gZmllbGROYW1lLnN1YnN0cmluZygxKTtcbiAgdmFsaWRhdGVBZ2dyZWdhdGVGaWVsZE5hbWUobmFtZSk7XG4gIHJldHVybiBuYW1lO1xufTtcblxuY29uc3QgdmFsaWRhdGVLZXlzID0gb2JqZWN0ID0+IHtcbiAgaWYgKHR5cGVvZiBvYmplY3QgPT0gJ29iamVjdCcpIHtcbiAgICBmb3IgKGNvbnN0IGtleSBpbiBvYmplY3QpIHtcbiAgICAgIGlmICh0eXBlb2Ygb2JqZWN0W2tleV0gPT0gJ29iamVjdCcpIHtcbiAgICAgICAgdmFsaWRhdGVLZXlzKG9iamVjdFtrZXldKTtcbiAgICAgIH1cblxuICAgICAgaWYgKGtleS5pbmNsdWRlcygnJCcpIHx8IGtleS5pbmNsdWRlcygnLicpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX05FU1RFRF9LRVksXG4gICAgICAgICAgXCJOZXN0ZWQga2V5cyBzaG91bGQgbm90IGNvbnRhaW4gdGhlICckJyBvciAnLicgY2hhcmFjdGVyc1wiXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICB9XG59O1xuXG4vLyBSZXR1cm5zIHRoZSBsaXN0IG9mIGpvaW4gdGFibGVzIG9uIGEgc2NoZW1hXG5jb25zdCBqb2luVGFibGVzRm9yU2NoZW1hID0gc2NoZW1hID0+IHtcbiAgY29uc3QgbGlzdCA9IFtdO1xuICBpZiAoc2NoZW1hKSB7XG4gICAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaChmaWVsZCA9PiB7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBsaXN0LnB1c2goYF9Kb2luOiR7ZmllbGR9OiR7c2NoZW1hLmNsYXNzTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuICByZXR1cm4gbGlzdDtcbn07XG5cbmludGVyZmFjZSBXaGVyZUNsYXVzZSB7XG4gIHBhdHRlcm46IHN0cmluZztcbiAgdmFsdWVzOiBBcnJheTxhbnk+O1xuICBzb3J0czogQXJyYXk8YW55Pjtcbn1cblxuY29uc3QgYnVpbGRXaGVyZUNsYXVzZSA9ICh7IHNjaGVtYSwgcXVlcnksIGluZGV4LCBjYXNlSW5zZW5zaXRpdmUgfSk6IFdoZXJlQ2xhdXNlID0+IHtcbiAgY29uc3QgcGF0dGVybnMgPSBbXTtcbiAgbGV0IHZhbHVlcyA9IFtdO1xuICBjb25zdCBzb3J0cyA9IFtdO1xuXG4gIHNjaGVtYSA9IHRvUG9zdGdyZXNTY2hlbWEoc2NoZW1hKTtcbiAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gcXVlcnkpIHtcbiAgICBjb25zdCBpc0FycmF5RmllbGQgPVxuICAgICAgc2NoZW1hLmZpZWxkcyAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdBcnJheSc7XG4gICAgY29uc3QgaW5pdGlhbFBhdHRlcm5zTGVuZ3RoID0gcGF0dGVybnMubGVuZ3RoO1xuICAgIGNvbnN0IGZpZWxkVmFsdWUgPSBxdWVyeVtmaWVsZE5hbWVdO1xuXG4gICAgLy8gbm90aGluZyBpbiB0aGUgc2NoZW1hLCBpdCdzIGdvbm5hIGJsb3cgdXBcbiAgICBpZiAoIXNjaGVtYS5maWVsZHNbZmllbGROYW1lXSkge1xuICAgICAgLy8gYXMgaXQgd29uJ3QgZXhpc3RcbiAgICAgIGlmIChmaWVsZFZhbHVlICYmIGZpZWxkVmFsdWUuJGV4aXN0cyA9PT0gZmFsc2UpIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBmaWVsZE5hbWUubWF0Y2goL15fYXV0aF9kYXRhXyhbYS16QS1aMC05X10rKSQvKTtcbiAgICBpZiAoYXV0aERhdGFNYXRjaCkge1xuICAgICAgLy8gVE9ETzogSGFuZGxlIHF1ZXJ5aW5nIGJ5IF9hdXRoX2RhdGFfcHJvdmlkZXIsIGF1dGhEYXRhIGlzIHN0b3JlZCBpbiBhdXRoRGF0YSBmaWVsZFxuICAgICAgY29udGludWU7XG4gICAgfSBlbHNlIGlmIChjYXNlSW5zZW5zaXRpdmUgJiYgKGZpZWxkTmFtZSA9PT0gJ3VzZXJuYW1lJyB8fCBmaWVsZE5hbWUgPT09ICdlbWFpbCcpKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGBMT1dFUigkJHtpbmRleH06bmFtZSkgPSBMT1dFUigkJHtpbmRleCArIDF9KWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgIGxldCBuYW1lID0gdHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKTtcbiAgICAgIGlmIChmaWVsZFZhbHVlID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpyYXcgSVMgTlVMTGApO1xuICAgICAgICB2YWx1ZXMucHVzaChuYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZmllbGRWYWx1ZS4kaW4pIHtcbiAgICAgICAgICBuYW1lID0gdHJhbnNmb3JtRG90RmllbGRUb0NvbXBvbmVudHMoZmllbGROYW1lKS5qb2luKCctPicpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCgkJHtpbmRleH06cmF3KTo6anNvbmIgQD4gJCR7aW5kZXggKyAxfTo6anNvbmJgKTtcbiAgICAgICAgICB2YWx1ZXMucHVzaChuYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLiRpbikpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS4kcmVnZXgpIHtcbiAgICAgICAgICAvLyBIYW5kbGUgbGF0ZXJcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06cmF3ID0gJCR7aW5kZXggKyAxfTo6dGV4dGApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKG5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgICAgdHlwZW9mIGZpZWxkVmFsdWUgPT09ICdvYmplY3QnICYmXG4gICAgICAgICAgIU9iamVjdC5rZXlzKGZpZWxkVmFsdWUpLnNvbWUoa2V5ID0+IGtleS5zdGFydHNXaXRoKCckJykpXG4gICAgICAgICkge1xuICAgICAgICAgIG5hbWUgPSB0cmFuc2Zvcm1Eb3RGaWVsZFRvQ29tcG9uZW50cyhmaWVsZE5hbWUpLmpvaW4oJy0+Jyk7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgKCQke2luZGV4fTpyYXcpOjpqc29uYiA9ICQke2luZGV4ICsgMX06Ompzb25iYCk7XG4gICAgICAgICAgdmFsdWVzLnB1c2gobmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSkpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwgfHwgZmllbGRWYWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOVUxMYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZSk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdib29sZWFuJykge1xuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAvLyBDYW4ndCBjYXN0IGJvb2xlYW4gdG8gZG91YmxlIHByZWNpc2lvblxuICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ051bWJlcicpIHtcbiAgICAgICAgLy8gU2hvdWxkIGFsd2F5cyByZXR1cm4gemVybyByZXN1bHRzXG4gICAgICAgIGNvbnN0IE1BWF9JTlRfUExVU19PTkUgPSA5MjIzMzcyMDM2ODU0Nzc1ODA4O1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIE1BWF9JTlRfUExVU19PTkUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ251bWJlcicpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfSBlbHNlIGlmIChbJyRvcicsICckbm9yJywgJyRhbmQnXS5pbmNsdWRlcyhmaWVsZE5hbWUpKSB7XG4gICAgICBjb25zdCBjbGF1c2VzID0gW107XG4gICAgICBjb25zdCBjbGF1c2VWYWx1ZXMgPSBbXTtcbiAgICAgIGZpZWxkVmFsdWUuZm9yRWFjaChzdWJRdWVyeSA9PiB7XG4gICAgICAgIGNvbnN0IGNsYXVzZSA9IGJ1aWxkV2hlcmVDbGF1c2Uoe1xuICAgICAgICAgIHNjaGVtYSxcbiAgICAgICAgICBxdWVyeTogc3ViUXVlcnksXG4gICAgICAgICAgaW5kZXgsXG4gICAgICAgICAgY2FzZUluc2Vuc2l0aXZlLFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKGNsYXVzZS5wYXR0ZXJuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjbGF1c2VzLnB1c2goY2xhdXNlLnBhdHRlcm4pO1xuICAgICAgICAgIGNsYXVzZVZhbHVlcy5wdXNoKC4uLmNsYXVzZS52YWx1ZXMpO1xuICAgICAgICAgIGluZGV4ICs9IGNsYXVzZS52YWx1ZXMubGVuZ3RoO1xuICAgICAgICB9XG4gICAgICB9KTtcblxuICAgICAgY29uc3Qgb3JPckFuZCA9IGZpZWxkTmFtZSA9PT0gJyRhbmQnID8gJyBBTkQgJyA6ICcgT1IgJztcbiAgICAgIGNvbnN0IG5vdCA9IGZpZWxkTmFtZSA9PT0gJyRub3InID8gJyBOT1QgJyA6ICcnO1xuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAke25vdH0oJHtjbGF1c2VzLmpvaW4ob3JPckFuZCl9KWApO1xuICAgICAgdmFsdWVzLnB1c2goLi4uY2xhdXNlVmFsdWVzKTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kbmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGlzQXJyYXlGaWVsZCkge1xuICAgICAgICBmaWVsZFZhbHVlLiRuZSA9IEpTT04uc3RyaW5naWZ5KFtmaWVsZFZhbHVlLiRuZV0pO1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGBOT1QgYXJyYXlfY29udGFpbnMoJCR7aW5kZXh9Om5hbWUsICQke2luZGV4ICsgMX0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpZiAoZmllbGRWYWx1ZS4kbmUgPT09IG51bGwpIHtcbiAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOT1QgTlVMTGApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBpZiBub3QgbnVsbCwgd2UgbmVlZCB0byBtYW51YWxseSBleGNsdWRlIG51bGxcbiAgICAgICAgICBpZiAoZmllbGRWYWx1ZS4kbmUuX190eXBlID09PSAnR2VvUG9pbnQnKSB7XG4gICAgICAgICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICAgICAgICBgKCQke2luZGV4fTpuYW1lIDw+IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pIE9SICQke2luZGV4fTpuYW1lIElTIE5VTEwpYFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgICAgICBjb25zdCBjYXN0VHlwZSA9IHRvUG9zdGdyZXNWYWx1ZUNhc3RUeXBlKGZpZWxkVmFsdWUuJG5lKTtcbiAgICAgICAgICAgICAgY29uc3QgY29uc3RyYWludEZpZWxkTmFtZSA9IGNhc3RUeXBlXG4gICAgICAgICAgICAgICAgPyBgQ0FTVCAoKCR7dHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKX0pIEFTICR7Y2FzdFR5cGV9KWBcbiAgICAgICAgICAgICAgICA6IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgICAgICAgYCgke2NvbnN0cmFpbnRGaWVsZE5hbWV9IDw+ICQke2luZGV4ICsgMX0gT1IgJHtjb25zdHJhaW50RmllbGROYW1lfSBJUyBOVUxMKWBcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJG5lID09PSAnb2JqZWN0JyAmJiBmaWVsZFZhbHVlLiRuZS4kcmVsYXRpdmVUaW1lKSB7XG4gICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAgICAgJyRyZWxhdGl2ZVRpbWUgY2FuIG9ubHkgYmUgdXNlZCB3aXRoIHRoZSAkbHQsICRsdGUsICRndCwgYW5kICRndGUgb3BlcmF0b3JzJ1xuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgcGF0dGVybnMucHVzaChgKCQke2luZGV4fTpuYW1lIDw+ICQke2luZGV4ICsgMX0gT1IgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTClgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZFZhbHVlLiRuZS5fX3R5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgY29uc3QgcG9pbnQgPSBmaWVsZFZhbHVlLiRuZTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlKTtcbiAgICAgICAgaW5kZXggKz0gMztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIFRPRE86IHN1cHBvcnQgYXJyYXlzXG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kbmUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoZmllbGRWYWx1ZS4kZXEgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGVxID09PSBudWxsKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5VTExgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgICAgICBjb25zdCBjYXN0VHlwZSA9IHRvUG9zdGdyZXNWYWx1ZUNhc3RUeXBlKGZpZWxkVmFsdWUuJGVxKTtcbiAgICAgICAgICBjb25zdCBjb25zdHJhaW50RmllbGROYW1lID0gY2FzdFR5cGVcbiAgICAgICAgICAgID8gYENBU1QgKCgke3RyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSl9KSBBUyAke2Nhc3RUeXBlfSlgXG4gICAgICAgICAgICA6IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgICAgdmFsdWVzLnB1c2goZmllbGRWYWx1ZS4kZXEpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCR7Y29uc3RyYWludEZpZWxkTmFtZX0gPSAkJHtpbmRleCsrfWApO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlLiRlcSA9PT0gJ29iamVjdCcgJiYgZmllbGRWYWx1ZS4kZXEuJHJlbGF0aXZlVGltZSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICckcmVsYXRpdmVUaW1lIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCB0aGUgJGx0LCAkbHRlLCAkZ3QsIGFuZCAkZ3RlIG9wZXJhdG9ycydcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kZXEpO1xuICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3QgaXNJbk9yTmluID0gQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRpbikgfHwgQXJyYXkuaXNBcnJheShmaWVsZFZhbHVlLiRuaW4pO1xuICAgIGlmIChcbiAgICAgIEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kaW4pICYmXG4gICAgICBpc0FycmF5RmllbGQgJiZcbiAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5jb250ZW50cyAmJlxuICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLmNvbnRlbnRzLnR5cGUgPT09ICdTdHJpbmcnXG4gICAgKSB7XG4gICAgICBjb25zdCBpblBhdHRlcm5zID0gW107XG4gICAgICBsZXQgYWxsb3dOdWxsID0gZmFsc2U7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgZmllbGRWYWx1ZS4kaW4uZm9yRWFjaCgobGlzdEVsZW0sIGxpc3RJbmRleCkgPT4ge1xuICAgICAgICBpZiAobGlzdEVsZW0gPT09IG51bGwpIHtcbiAgICAgICAgICBhbGxvd051bGwgPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGxpc3RFbGVtKTtcbiAgICAgICAgICBpblBhdHRlcm5zLnB1c2goYCQke2luZGV4ICsgMSArIGxpc3RJbmRleCAtIChhbGxvd051bGwgPyAxIDogMCl9YCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgaWYgKGFsbG93TnVsbCkge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAoJCR7aW5kZXh9Om5hbWUgSVMgTlVMTCBPUiAkJHtpbmRleH06bmFtZSAmJiBBUlJBWVske2luUGF0dGVybnMuam9pbigpfV0pYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSAmJiBBUlJBWVske2luUGF0dGVybnMuam9pbigpfV1gKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ID0gaW5kZXggKyAxICsgaW5QYXR0ZXJucy5sZW5ndGg7XG4gICAgfSBlbHNlIGlmIChpc0luT3JOaW4pIHtcbiAgICAgIHZhciBjcmVhdGVDb25zdHJhaW50ID0gKGJhc2VBcnJheSwgbm90SW4pID0+IHtcbiAgICAgICAgY29uc3Qgbm90ID0gbm90SW4gPyAnIE5PVCAnIDogJyc7XG4gICAgICAgIGlmIChiYXNlQXJyYXkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGlmIChpc0FycmF5RmllbGQpIHtcbiAgICAgICAgICAgIHBhdHRlcm5zLnB1c2goYCR7bm90fSBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgKTtcbiAgICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoYmFzZUFycmF5KSk7XG4gICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBIYW5kbGUgTmVzdGVkIERvdCBOb3RhdGlvbiBBYm92ZVxuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPj0gMCkge1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBmaWVsZFR5cGUgPSBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0/LnR5cGU7XG4gICAgICAgICAgICBpZiAoZmllbGRUeXBlID09PSAnU3RyaW5nJykge1xuICAgICAgICAgICAgICBjb25zdCBvcGVyYXRvck5hbWUgPSBub3RJbiA/ICckbmluJyA6ICckaW4nO1xuICAgICAgICAgICAgICBmb3IgKGNvbnN0IGVsZW0gb2YgYmFzZUFycmF5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGVsZW0gIT0gbnVsbCAmJiB0eXBlb2YgZWxlbSAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgICAgICAgICAgYCR7b3BlcmF0b3JOYW1lfSBlbGVtZW50IHR5cGUgbWlzbWF0Y2g6IGV4cGVjdGVkIHN0cmluZyBmb3IgZmllbGQgXCIke2ZpZWxkTmFtZX1cImBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBpblBhdHRlcm5zID0gW107XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICAgICAgYmFzZUFycmF5LmZvckVhY2goKGxpc3RFbGVtLCBsaXN0SW5kZXgpID0+IHtcbiAgICAgICAgICAgICAgaWYgKGxpc3RFbGVtICE9IG51bGwpIHtcbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaChsaXN0RWxlbSk7XG4gICAgICAgICAgICAgICAgaW5QYXR0ZXJucy5wdXNoKGAkJHtpbmRleCArIDEgKyBsaXN0SW5kZXh9YCk7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgJHtub3R9IElOICgke2luUGF0dGVybnMuam9pbigpfSlgKTtcbiAgICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxICsgaW5QYXR0ZXJucy5sZW5ndGg7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKCFub3RJbikge1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgSVMgTlVMTGApO1xuICAgICAgICAgIGluZGV4ID0gaW5kZXggKyAxO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEhhbmRsZSBlbXB0eSBhcnJheVxuICAgICAgICAgIGlmIChub3RJbikge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDEnKTsgLy8gUmV0dXJuIGFsbCB2YWx1ZXNcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaCgnMSA9IDInKTsgLy8gUmV0dXJuIG5vIHZhbHVlc1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfTtcbiAgICAgIGlmIChmaWVsZFZhbHVlLiRpbikge1xuICAgICAgICBjcmVhdGVDb25zdHJhaW50KFxuICAgICAgICAgIF8uZmxhdE1hcChmaWVsZFZhbHVlLiRpbiwgZWx0ID0+IGVsdCksXG4gICAgICAgICAgZmFsc2VcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChmaWVsZFZhbHVlLiRuaW4pIHtcbiAgICAgICAgY3JlYXRlQ29uc3RyYWludChcbiAgICAgICAgICBfLmZsYXRNYXAoZmllbGRWYWx1ZS4kbmluLCBlbHQgPT4gZWx0KSxcbiAgICAgICAgICB0cnVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kaW4gIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnYmFkICRpbiB2YWx1ZScpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJG5pbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sICdiYWQgJG5pbiB2YWx1ZScpO1xuICAgIH1cblxuICAgIGlmIChBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUuJGFsbCkgJiYgaXNBcnJheUZpZWxkKSB7XG4gICAgICBpZiAoaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aChmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgIGlmICghaXNBbGxWYWx1ZXNSZWdleE9yTm9uZShmaWVsZFZhbHVlLiRhbGwpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICAgJ0FsbCAkYWxsIHZhbHVlcyBtdXN0IGJlIG9mIHJlZ2V4IHR5cGUgb3Igbm9uZTogJyArIGZpZWxkVmFsdWUuJGFsbFxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZpZWxkVmFsdWUuJGFsbC5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gcHJvY2Vzc1JlZ2V4UGF0dGVybihmaWVsZFZhbHVlLiRhbGxbaV0uJHJlZ2V4KTtcbiAgICAgICAgICBmaWVsZFZhbHVlLiRhbGxbaV0gPSB2YWx1ZS5zdWJzdHJpbmcoMSkgKyAnJSc7XG4gICAgICAgIH1cbiAgICAgICAgcGF0dGVybnMucHVzaChgYXJyYXlfY29udGFpbnNfYWxsX3JlZ2V4KCQke2luZGV4fTpuYW1lLCAkJHtpbmRleCArIDF9Ojpqc29uYilgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYGFycmF5X2NvbnRhaW5zX2FsbCgkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfTo6anNvbmIpYCk7XG4gICAgICB9XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUuJGFsbCkpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoZmllbGRWYWx1ZS4kYWxsKSkge1xuICAgICAgaWYgKGZpZWxkVmFsdWUuJGFsbC5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS4kYWxsWzBdLm9iamVjdElkKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodHlwZW9mIGZpZWxkVmFsdWUuJGV4aXN0cyAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIGlmICh0eXBlb2YgZmllbGRWYWx1ZS4kZXhpc3RzID09PSAnb2JqZWN0JyAmJiBmaWVsZFZhbHVlLiRleGlzdHMuJHJlbGF0aXZlVGltZSkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICckcmVsYXRpdmVUaW1lIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCB0aGUgJGx0LCAkbHRlLCAkZ3QsIGFuZCAkZ3RlIG9wZXJhdG9ycydcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS4kZXhpc3RzKSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIElTIE5PVCBOVUxMYCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSBJUyBOVUxMYCk7XG4gICAgICB9XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaW5kZXggKz0gMTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kY29udGFpbmVkQnkpIHtcbiAgICAgIGNvbnN0IGFyciA9IGZpZWxkVmFsdWUuJGNvbnRhaW5lZEJ5O1xuICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGFycikpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgYGJhZCAkY29udGFpbmVkQnk6IHNob3VsZCBiZSBhbiBhcnJheWApO1xuICAgICAgfVxuXG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA8QCAkJHtpbmRleCArIDF9Ojpqc29uYmApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShhcnIpKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJHRleHQpIHtcbiAgICAgIGNvbnN0IHNlYXJjaCA9IGZpZWxkVmFsdWUuJHRleHQuJHNlYXJjaDtcbiAgICAgIGxldCBsYW5ndWFnZSA9ICdlbmdsaXNoJztcbiAgICAgIGlmICh0eXBlb2Ygc2VhcmNoICE9PSAnb2JqZWN0Jykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkICR0ZXh0OiAkc2VhcmNoLCBzaG91bGQgYmUgb2JqZWN0YCk7XG4gICAgICB9XG4gICAgICBpZiAoIXNlYXJjaC4kdGVybSB8fCB0eXBlb2Ygc2VhcmNoLiR0ZXJtICE9PSAnc3RyaW5nJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCBgYmFkICR0ZXh0OiAkdGVybSwgc2hvdWxkIGJlIHN0cmluZ2ApO1xuICAgICAgfVxuICAgICAgaWYgKHNlYXJjaC4kbGFuZ3VhZ2UgJiYgdHlwZW9mIHNlYXJjaC4kbGFuZ3VhZ2UgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBiYWQgJHRleHQ6ICRsYW5ndWFnZSwgc2hvdWxkIGJlIHN0cmluZ2ApO1xuICAgICAgfSBlbHNlIGlmIChzZWFyY2guJGxhbmd1YWdlKSB7XG4gICAgICAgIGxhbmd1YWdlID0gc2VhcmNoLiRsYW5ndWFnZTtcbiAgICAgIH1cbiAgICAgIGlmIChzZWFyY2guJGNhc2VTZW5zaXRpdmUgJiYgdHlwZW9mIHNlYXJjaC4kY2FzZVNlbnNpdGl2ZSAhPT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJGNhc2VTZW5zaXRpdmUsIHNob3VsZCBiZSBib29sZWFuYFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIGlmIChzZWFyY2guJGNhc2VTZW5zaXRpdmUpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkY2FzZVNlbnNpdGl2ZSBub3Qgc3VwcG9ydGVkLCBwbGVhc2UgdXNlICRyZWdleCBvciBjcmVhdGUgYSBzZXBhcmF0ZSBsb3dlciBjYXNlIGNvbHVtbi5gXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBpZiAoc2VhcmNoLiRkaWFjcml0aWNTZW5zaXRpdmUgJiYgdHlwZW9mIHNlYXJjaC4kZGlhY3JpdGljU2Vuc2l0aXZlICE9PSAnYm9vbGVhbicpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICBgYmFkICR0ZXh0OiAkZGlhY3JpdGljU2Vuc2l0aXZlLCBzaG91bGQgYmUgYm9vbGVhbmBcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoc2VhcmNoLiRkaWFjcml0aWNTZW5zaXRpdmUgPT09IGZhbHNlKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgYGJhZCAkdGV4dDogJGRpYWNyaXRpY1NlbnNpdGl2ZSAtIGZhbHNlIG5vdCBzdXBwb3J0ZWQsIGluc3RhbGwgUG9zdGdyZXMgVW5hY2NlbnQgRXh0ZW5zaW9uYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcGF0dGVybnMucHVzaChcbiAgICAgICAgYHRvX3RzdmVjdG9yKCQke2luZGV4fSwgJCR7aW5kZXggKyAxfTpuYW1lKSBAQCB0b190c3F1ZXJ5KCQke2luZGV4ICsgMn0sICQke2luZGV4ICsgM30pYFxuICAgICAgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGxhbmd1YWdlLCBmaWVsZE5hbWUsIGxhbmd1YWdlLCBzZWFyY2guJHRlcm0pO1xuICAgICAgaW5kZXggKz0gNDtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kbmVhclNwaGVyZSkge1xuICAgICAgY29uc3QgcG9pbnQgPSBmaWVsZFZhbHVlLiRuZWFyU3BoZXJlO1xuICAgICAgY29uc3QgZGlzdGFuY2UgPSBmaWVsZFZhbHVlLiRtYXhEaXN0YW5jZTtcbiAgICAgIGNvbnN0IGRpc3RhbmNlSW5LTSA9IGRpc3RhbmNlICogNjM3MSAqIDEwMDA7XG4gICAgICBwYXR0ZXJucy5wdXNoKFxuICAgICAgICBgU1RfRGlzdGFuY2VTcGhlcmUoJCR7aW5kZXh9Om5hbWU6Omdlb21ldHJ5LCBQT0lOVCgkJHtpbmRleCArIDF9LCAkJHtpbmRleCArIDJcbiAgICAgICAgfSk6Omdlb21ldHJ5KSA8PSAkJHtpbmRleCArIDN9YFxuICAgICAgKTtcbiAgICAgIHNvcnRzLnB1c2goXG4gICAgICAgIGBTVF9EaXN0YW5jZVNwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMlxuICAgICAgICB9KTo6Z2VvbWV0cnkpIEFTQ2BcbiAgICAgICk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIHBvaW50LmxvbmdpdHVkZSwgcG9pbnQubGF0aXR1ZGUsIGRpc3RhbmNlSW5LTSk7XG4gICAgICBpbmRleCArPSA0O1xuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLiR3aXRoaW4gJiYgZmllbGRWYWx1ZS4kd2l0aGluLiRib3gpIHtcbiAgICAgIGNvbnN0IGJveCA9IGZpZWxkVmFsdWUuJHdpdGhpbi4kYm94O1xuICAgICAgY29uc3QgbGVmdCA9IGJveFswXS5sb25naXR1ZGU7XG4gICAgICBjb25zdCBib3R0b20gPSBib3hbMF0ubGF0aXR1ZGU7XG4gICAgICBjb25zdCByaWdodCA9IGJveFsxXS5sb25naXR1ZGU7XG4gICAgICBjb25zdCB0b3AgPSBib3hbMV0ubGF0aXR1ZGU7XG5cbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lOjpwb2ludCA8QCAkJHtpbmRleCArIDF9Ojpib3hgKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgYCgoJHtsZWZ0fSwgJHtib3R0b219KSwgKCR7cmlnaHR9LCAke3RvcH0pKWApO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kZ2VvV2l0aGluICYmIGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kY2VudGVyU3BoZXJlKSB7XG4gICAgICBjb25zdCBjZW50ZXJTcGhlcmUgPSBmaWVsZFZhbHVlLiRnZW9XaXRoaW4uJGNlbnRlclNwaGVyZTtcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShjZW50ZXJTcGhlcmUpIHx8IGNlbnRlclNwaGVyZS5sZW5ndGggPCAyKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIHNob3VsZCBiZSBhbiBhcnJheSBvZiBQYXJzZS5HZW9Qb2ludCBhbmQgZGlzdGFuY2UnXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBHZXQgcG9pbnQsIGNvbnZlcnQgdG8gZ2VvIHBvaW50IGlmIG5lY2Vzc2FyeSBhbmQgdmFsaWRhdGVcbiAgICAgIGxldCBwb2ludCA9IGNlbnRlclNwaGVyZVswXTtcbiAgICAgIGlmIChBcnJheS5pc0FycmF5KHBvaW50KSAmJiBwb2ludC5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgcG9pbnQgPSBuZXcgUGFyc2UuR2VvUG9pbnQocG9pbnRbMV0sIHBvaW50WzBdKTtcbiAgICAgIH0gZWxzZSBpZiAoIUdlb1BvaW50Q29kZXIuaXNWYWxpZEpTT04ocG9pbnQpKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlOyAkY2VudGVyU3BoZXJlIGdlbyBwb2ludCBpbnZhbGlkJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgUGFyc2UuR2VvUG9pbnQuX3ZhbGlkYXRlKHBvaW50LmxhdGl0dWRlLCBwb2ludC5sb25naXR1ZGUpO1xuICAgICAgLy8gR2V0IGRpc3RhbmNlIGFuZCB2YWxpZGF0ZVxuICAgICAgY29uc3QgZGlzdGFuY2UgPSBjZW50ZXJTcGhlcmVbMV07XG4gICAgICBpZiAoaXNOYU4oZGlzdGFuY2UpIHx8IGRpc3RhbmNlIDwgMCkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJGNlbnRlclNwaGVyZSBkaXN0YW5jZSBpbnZhbGlkJ1xuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgZGlzdGFuY2VJbktNID0gZGlzdGFuY2UgKiA2MzcxICogMTAwMDtcbiAgICAgIHBhdHRlcm5zLnB1c2goXG4gICAgICAgIGBTVF9EaXN0YW5jZVNwaGVyZSgkJHtpbmRleH06bmFtZTo6Z2VvbWV0cnksIFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMlxuICAgICAgICB9KTo6Z2VvbWV0cnkpIDw9ICQke2luZGV4ICsgM31gXG4gICAgICApO1xuICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBwb2ludC5sb25naXR1ZGUsIHBvaW50LmxhdGl0dWRlLCBkaXN0YW5jZUluS00pO1xuICAgICAgaW5kZXggKz0gNDtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS4kZ2VvV2l0aGluICYmIGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kcG9seWdvbikge1xuICAgICAgY29uc3QgcG9seWdvbiA9IGZpZWxkVmFsdWUuJGdlb1dpdGhpbi4kcG9seWdvbjtcbiAgICAgIGxldCBwb2ludHM7XG4gICAgICBpZiAodHlwZW9mIHBvbHlnb24gPT09ICdvYmplY3QnICYmIHBvbHlnb24uX190eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgICAgaWYgKCFwb2x5Z29uLmNvb3JkaW5hdGVzIHx8IHBvbHlnb24uY29vcmRpbmF0ZXMubGVuZ3RoIDwgMykge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICdiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgUG9seWdvbi5jb29yZGluYXRlcyBzaG91bGQgY29udGFpbiBhdCBsZWFzdCAzIGxvbi9sYXQgcGFpcnMnXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBwb2ludHMgPSBwb2x5Z29uLmNvb3JkaW5hdGVzO1xuICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHBvbHlnb24pKSB7XG4gICAgICAgIGlmIChwb2x5Z29uLmxlbmd0aCA8IDMpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgICAnYmFkICRnZW9XaXRoaW4gdmFsdWU7ICRwb2x5Z29uIHNob3VsZCBjb250YWluIGF0IGxlYXN0IDMgR2VvUG9pbnRzJ1xuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcG9pbnRzID0gcG9seWdvbjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICBQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sXG4gICAgICAgICAgXCJiYWQgJGdlb1dpdGhpbiB2YWx1ZTsgJHBvbHlnb24gc2hvdWxkIGJlIFBvbHlnb24gb2JqZWN0IG9yIEFycmF5IG9mIFBhcnNlLkdlb1BvaW50J3NcIlxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcG9pbnRzID0gcG9pbnRzXG4gICAgICAgIC5tYXAocG9pbnQgPT4ge1xuICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHBvaW50KSAmJiBwb2ludC5sZW5ndGggPT09IDIpIHtcbiAgICAgICAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludFsxXSwgcG9pbnRbMF0pO1xuICAgICAgICAgICAgcmV0dXJuIGAoJHtwb2ludFswXX0sICR7cG9pbnRbMV19KWA7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eXBlb2YgcG9pbnQgIT09ICdvYmplY3QnIHx8IHBvaW50Ll9fdHlwZSAhPT0gJ0dlb1BvaW50Jykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFBhcnNlLkVycm9yLklOVkFMSURfSlNPTiwgJ2JhZCAkZ2VvV2l0aGluIHZhbHVlJyk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludC5sYXRpdHVkZSwgcG9pbnQubG9uZ2l0dWRlKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGAoJHtwb2ludC5sb25naXR1ZGV9LCAke3BvaW50LmxhdGl0dWRlfSlgO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbignLCAnKTtcblxuICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWU6OnBvaW50IDxAICQke2luZGV4ICsgMX06OnBvbHlnb25gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgYCgke3BvaW50c30pYCk7XG4gICAgICBpbmRleCArPSAyO1xuICAgIH1cbiAgICBpZiAoZmllbGRWYWx1ZS4kZ2VvSW50ZXJzZWN0cyAmJiBmaWVsZFZhbHVlLiRnZW9JbnRlcnNlY3RzLiRwb2ludCkge1xuICAgICAgY29uc3QgcG9pbnQgPSBmaWVsZFZhbHVlLiRnZW9JbnRlcnNlY3RzLiRwb2ludDtcbiAgICAgIGlmICh0eXBlb2YgcG9pbnQgIT09ICdvYmplY3QnIHx8IHBvaW50Ll9fdHlwZSAhPT0gJ0dlb1BvaW50Jykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLFxuICAgICAgICAgICdiYWQgJGdlb0ludGVyc2VjdCB2YWx1ZTsgJHBvaW50IHNob3VsZCBiZSBHZW9Qb2ludCdcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIFBhcnNlLkdlb1BvaW50Ll92YWxpZGF0ZShwb2ludC5sYXRpdHVkZSwgcG9pbnQubG9uZ2l0dWRlKTtcbiAgICAgIH1cbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lOjpwb2x5Z29uIEA+ICQke2luZGV4ICsgMX06OnBvaW50YCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGAoJHtwb2ludC5sb25naXR1ZGV9LCAke3BvaW50LmxhdGl0dWRlfSlgKTtcbiAgICAgIGluZGV4ICs9IDI7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuJHJlZ2V4KSB7XG4gICAgICBsZXQgcmVnZXggPSBmaWVsZFZhbHVlLiRyZWdleDtcbiAgICAgIGxldCBvcGVyYXRvciA9ICd+JztcbiAgICAgIGNvbnN0IG9wdHMgPSBmaWVsZFZhbHVlLiRvcHRpb25zO1xuICAgICAgaWYgKG9wdHMpIHtcbiAgICAgICAgaWYgKG9wdHMuaW5kZXhPZignaScpID49IDApIHtcbiAgICAgICAgICBvcGVyYXRvciA9ICd+Kic7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG9wdHMuaW5kZXhPZigneCcpID49IDApIHtcbiAgICAgICAgICByZWdleCA9IHJlbW92ZVdoaXRlU3BhY2UocmVnZXgpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJlZ2V4ID0gcHJvY2Vzc1JlZ2V4UGF0dGVybihyZWdleCk7XG5cbiAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDApIHtcbiAgICAgICAgY29uc3QgbmFtZSA9IHRyYW5zZm9ybURvdEZpZWxkKGZpZWxkTmFtZSk7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpyYXcgJHtvcGVyYXRvcn0gJyQke2luZGV4ICsgMX06cmF3J2ApO1xuICAgICAgICB2YWx1ZXMucHVzaChuYW1lLCByZWdleCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSAke29wZXJhdG9yfSAnJCR7aW5kZXggKyAxfTpyYXcnYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgcmVnZXgpO1xuICAgICAgfVxuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdQb2ludGVyJykge1xuICAgICAgaWYgKGlzQXJyYXlGaWVsZCkge1xuICAgICAgICBwYXR0ZXJucy5wdXNoKGBhcnJheV9jb250YWlucygkJHtpbmRleH06bmFtZSwgJCR7aW5kZXggKyAxfSlgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShbZmllbGRWYWx1ZV0pKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUub2JqZWN0SWQpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ0RhdGUnKSB7XG4gICAgICBwYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5pc28pO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIH49IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pYCk7XG4gICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUubG9uZ2l0dWRlLCBmaWVsZFZhbHVlLmxhdGl0dWRlKTtcbiAgICAgIGluZGV4ICs9IDM7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkVmFsdWUuX190eXBlID09PSAnUG9seWdvbicpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChmaWVsZFZhbHVlLmNvb3JkaW5hdGVzKTtcbiAgICAgIHBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lIH49ICQke2luZGV4ICsgMX06OnBvbHlnb25gKTtcbiAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdmFsdWUpO1xuICAgICAgaW5kZXggKz0gMjtcbiAgICB9XG5cbiAgICBPYmplY3Qua2V5cyhQYXJzZVRvUG9zZ3Jlc0NvbXBhcmF0b3IpLmZvckVhY2goY21wID0+IHtcbiAgICAgIGlmIChmaWVsZFZhbHVlW2NtcF0gfHwgZmllbGRWYWx1ZVtjbXBdID09PSAwKSB7XG4gICAgICAgIGNvbnN0IHBnQ29tcGFyYXRvciA9IFBhcnNlVG9Qb3NncmVzQ29tcGFyYXRvcltjbXBdO1xuICAgICAgICBsZXQgY29uc3RyYWludEZpZWxkTmFtZTtcbiAgICAgICAgbGV0IHBvc3RncmVzVmFsdWUgPSB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZVtjbXBdKTtcblxuICAgICAgICBpZiAoZmllbGROYW1lLmluZGV4T2YoJy4nKSA+PSAwKSB7XG4gICAgICAgICAgY29uc3QgY2FzdFR5cGUgPSB0b1Bvc3RncmVzVmFsdWVDYXN0VHlwZShmaWVsZFZhbHVlW2NtcF0pO1xuICAgICAgICAgIGNvbnN0cmFpbnRGaWVsZE5hbWUgPSBjYXN0VHlwZVxuICAgICAgICAgICAgPyBgQ0FTVCAoKCR7dHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKX0pIEFTICR7Y2FzdFR5cGV9KWBcbiAgICAgICAgICAgIDogdHJhbnNmb3JtRG90RmllbGQoZmllbGROYW1lKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZiAodHlwZW9mIHBvc3RncmVzVmFsdWUgPT09ICdvYmplY3QnICYmIHBvc3RncmVzVmFsdWUuJHJlbGF0aXZlVGltZSkge1xuICAgICAgICAgICAgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlICE9PSAnRGF0ZScpIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgICAnJHJlbGF0aXZlVGltZSBjYW4gb25seSBiZSB1c2VkIHdpdGggRGF0ZSBmaWVsZCdcbiAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnN0IHBhcnNlclJlc3VsdCA9IFV0aWxzLnJlbGF0aXZlVGltZVRvRGF0ZShwb3N0Z3Jlc1ZhbHVlLiRyZWxhdGl2ZVRpbWUpO1xuICAgICAgICAgICAgaWYgKHBhcnNlclJlc3VsdC5zdGF0dXMgPT09ICdzdWNjZXNzJykge1xuICAgICAgICAgICAgICBwb3N0Z3Jlc1ZhbHVlID0gdG9Qb3N0Z3Jlc1ZhbHVlKHBhcnNlclJlc3VsdC5yZXN1bHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgICAgICAgY29uc29sZS5lcnJvcignRXJyb3Igd2hpbGUgcGFyc2luZyByZWxhdGl2ZSBkYXRlJywgcGFyc2VyUmVzdWx0KTtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfSlNPTixcbiAgICAgICAgICAgICAgICBgYmFkICRyZWxhdGl2ZVRpbWUgKCR7cG9zdGdyZXNWYWx1ZS4kcmVsYXRpdmVUaW1lfSkgdmFsdWUuICR7cGFyc2VyUmVzdWx0LmluZm99YFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdHJhaW50RmllbGROYW1lID0gYCQke2luZGV4Kyt9Om5hbWVgO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIH1cbiAgICAgICAgdmFsdWVzLnB1c2gocG9zdGdyZXNWYWx1ZSk7XG4gICAgICAgIHBhdHRlcm5zLnB1c2goYCR7Y29uc3RyYWludEZpZWxkTmFtZX0gJHtwZ0NvbXBhcmF0b3J9ICQke2luZGV4Kyt9YCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAoaW5pdGlhbFBhdHRlcm5zTGVuZ3RoID09PSBwYXR0ZXJucy5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgYFBvc3RncmVzIGRvZXNuJ3Qgc3VwcG9ydCB0aGlzIHF1ZXJ5IHR5cGUgeWV0ICR7SlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSl9YFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgdmFsdWVzID0gdmFsdWVzLm1hcCh0cmFuc2Zvcm1WYWx1ZSk7XG4gIHJldHVybiB7IHBhdHRlcm46IHBhdHRlcm5zLmpvaW4oJyBBTkQgJyksIHZhbHVlcywgc29ydHMgfTtcbn07XG5cbmV4cG9ydCBjbGFzcyBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyIGltcGxlbWVudHMgU3RvcmFnZUFkYXB0ZXIge1xuICBjYW5Tb3J0T25Kb2luVGFibGVzOiBib29sZWFuO1xuICBlbmFibGVTY2hlbWFIb29rczogYm9vbGVhbjtcblxuICAvLyBQcml2YXRlXG4gIF9jb2xsZWN0aW9uUHJlZml4OiBzdHJpbmc7XG4gIF9jbGllbnQ6IGFueTtcbiAgX29uY2hhbmdlOiBhbnk7XG4gIF9wZ3A6IGFueTtcbiAgX3N0cmVhbTogYW55O1xuICBfdXVpZDogYW55O1xuICBzY2hlbWFDYWNoZVR0bDogP251bWJlcjtcbiAgZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHsgdXJpLCBjb2xsZWN0aW9uUHJlZml4ID0gJycsIGRhdGFiYXNlT3B0aW9ucyA9IHt9IH06IGFueSkge1xuICAgIGNvbnN0IG9wdGlvbnMgPSB7IC4uLmRhdGFiYXNlT3B0aW9ucyB9O1xuICAgIHRoaXMuX2NvbGxlY3Rpb25QcmVmaXggPSBjb2xsZWN0aW9uUHJlZml4O1xuICAgIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MgPSAhIWRhdGFiYXNlT3B0aW9ucy5lbmFibGVTY2hlbWFIb29rcztcbiAgICB0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbiA9ICEhZGF0YWJhc2VPcHRpb25zLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbjtcblxuICAgIHRoaXMuc2NoZW1hQ2FjaGVUdGwgPSBkYXRhYmFzZU9wdGlvbnMuc2NoZW1hQ2FjaGVUdGw7XG4gICAgZm9yIChjb25zdCBrZXkgb2YgWydlbmFibGVTY2hlbWFIb29rcycsICdzY2hlbWFDYWNoZVR0bCcsICdkaXNhYmxlSW5kZXhGaWVsZFZhbGlkYXRpb24nXSkge1xuICAgICAgZGVsZXRlIG9wdGlvbnNba2V5XTtcbiAgICB9XG5cbiAgICBjb25zdCB7IGNsaWVudCwgcGdwIH0gPSBjcmVhdGVDbGllbnQodXJpLCBvcHRpb25zKTtcbiAgICB0aGlzLl9jbGllbnQgPSBjbGllbnQ7XG4gICAgdGhpcy5fb25jaGFuZ2UgPSAoKSA9PiB7IH07XG4gICAgdGhpcy5fcGdwID0gcGdwO1xuICAgIHRoaXMuX3V1aWQgPSByYW5kb21VVUlEKCk7XG4gICAgdGhpcy5jYW5Tb3J0T25Kb2luVGFibGVzID0gZmFsc2U7XG4gIH1cblxuICB3YXRjaChjYWxsYmFjazogKCkgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMuX29uY2hhbmdlID0gY2FsbGJhY2s7XG4gIH1cblxuICAvL05vdGUgdGhhdCBhbmFseXplPXRydWUgd2lsbCBydW4gdGhlIHF1ZXJ5LCBleGVjdXRpbmcgSU5TRVJUUywgREVMRVRFUywgZXRjLlxuICBjcmVhdGVFeHBsYWluYWJsZVF1ZXJ5KHF1ZXJ5OiBzdHJpbmcsIGFuYWx5emU6IGJvb2xlYW4gPSBmYWxzZSkge1xuICAgIGlmIChhbmFseXplKSB7XG4gICAgICByZXR1cm4gJ0VYUExBSU4gKEFOQUxZWkUsIEZPUk1BVCBKU09OKSAnICsgcXVlcnk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiAnRVhQTEFJTiAoRk9STUFUIEpTT04pICcgKyBxdWVyeTtcbiAgICB9XG4gIH1cblxuICBoYW5kbGVTaHV0ZG93bigpIHtcbiAgICBpZiAodGhpcy5fc3RyZWFtKSB7XG4gICAgICB0aGlzLl9zdHJlYW0uZG9uZSgpO1xuICAgICAgZGVsZXRlIHRoaXMuX3N0cmVhbTtcbiAgICB9XG4gICAgaWYgKCF0aGlzLl9jbGllbnQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5fY2xpZW50LiRwb29sLmVuZCgpO1xuICB9XG5cbiAgYXN5bmMgX2xpc3RlblRvU2NoZW1hKCkge1xuICAgIGlmICghdGhpcy5fc3RyZWFtICYmIHRoaXMuZW5hYmxlU2NoZW1hSG9va3MpIHtcbiAgICAgIHRoaXMuX3N0cmVhbSA9IGF3YWl0IHRoaXMuX2NsaWVudC5jb25uZWN0KHsgZGlyZWN0OiB0cnVlIH0pO1xuICAgICAgdGhpcy5fc3RyZWFtLmNsaWVudC5vbignbm90aWZpY2F0aW9uJywgZGF0YSA9PiB7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGRhdGEucGF5bG9hZCk7XG4gICAgICAgIGlmIChwYXlsb2FkLnNlbmRlcklkICE9PSB0aGlzLl91dWlkKSB7XG4gICAgICAgICAgdGhpcy5fb25jaGFuZ2UoKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICBhd2FpdCB0aGlzLl9zdHJlYW0ubm9uZSgnTElTVEVOICQxficsICdzY2hlbWEuY2hhbmdlJyk7XG4gICAgfVxuICB9XG5cbiAgX25vdGlmeVNjaGVtYUNoYW5nZSgpIHtcbiAgICBpZiAodGhpcy5fc3RyZWFtKSB7XG4gICAgICB0aGlzLl9zdHJlYW1cbiAgICAgICAgLm5vbmUoJ05PVElGWSAkMX4sICQyJywgWydzY2hlbWEuY2hhbmdlJywgeyBzZW5kZXJJZDogdGhpcy5fdXVpZCB9XSlcbiAgICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICAgIGNvbnNvbGUubG9nKCdGYWlsZWQgdG8gTm90aWZ5OicsIGVycm9yKTsgLy8gdW5saWtlbHkgdG8gZXZlciBoYXBwZW5cbiAgICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgYXN5bmMgX2Vuc3VyZVNjaGVtYUNvbGxlY3Rpb25FeGlzdHMoY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGF3YWl0IGNvbm5cbiAgICAgIC5ub25lKFxuICAgICAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgXCJfU0NIRU1BXCIgKCBcImNsYXNzTmFtZVwiIHZhckNoYXIoMTIwKSwgXCJzY2hlbWFcIiBqc29uYiwgXCJpc1BhcnNlQ2xhc3NcIiBib29sLCBQUklNQVJZIEtFWSAoXCJjbGFzc05hbWVcIikgKSdcbiAgICAgIClcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBjbGFzc0V4aXN0cyhuYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm9uZShcbiAgICAgICdTRUxFQ1QgRVhJU1RTIChTRUxFQ1QgMSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS50YWJsZXMgV0hFUkUgdGFibGVfbmFtZSA9ICQxKScsXG4gICAgICBbbmFtZV0sXG4gICAgICBhID0+IGEuZXhpc3RzXG4gICAgKTtcbiAgfVxuXG4gIGFzeW5jIHNldENsYXNzTGV2ZWxQZXJtaXNzaW9ucyhjbGFzc05hbWU6IHN0cmluZywgQ0xQczogYW55KSB7XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50LnRhc2soJ3NldC1jbGFzcy1sZXZlbC1wZXJtaXNzaW9ucycsIGFzeW5jIHQgPT4ge1xuICAgICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgJ3NjaGVtYScsICdjbGFzc0xldmVsUGVybWlzc2lvbnMnLCBKU09OLnN0cmluZ2lmeShDTFBzKV07XG4gICAgICBhd2FpdCB0Lm5vbmUoXG4gICAgICAgIGBVUERBVEUgXCJfU0NIRU1BXCIgU0VUICQyOm5hbWUgPSBqc29uX29iamVjdF9zZXRfa2V5KCQyOm5hbWUsICQzOjp0ZXh0LCAkNDo6anNvbmIpIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsXG4gICAgICAgIHZhbHVlc1xuICAgICAgKTtcbiAgICB9KTtcbiAgICB0aGlzLl9ub3RpZnlTY2hlbWFDaGFuZ2UoKTtcbiAgfVxuXG4gIGFzeW5jIHNldEluZGV4ZXNXaXRoU2NoZW1hRm9ybWF0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHN1Ym1pdHRlZEluZGV4ZXM6IGFueSxcbiAgICBleGlzdGluZ0luZGV4ZXM6IGFueSA9IHt9LFxuICAgIGZpZWxkczogYW55LFxuICAgIGNvbm46ID9hbnlcbiAgKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHNlbGYgPSB0aGlzO1xuICAgIGlmIChzdWJtaXR0ZWRJbmRleGVzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICB9XG4gICAgaWYgKE9iamVjdC5rZXlzKGV4aXN0aW5nSW5kZXhlcykubGVuZ3RoID09PSAwKSB7XG4gICAgICBleGlzdGluZ0luZGV4ZXMgPSB7IF9pZF86IHsgX2lkOiAxIH0gfTtcbiAgICB9XG4gICAgY29uc3QgZGVsZXRlZEluZGV4ZXMgPSBbXTtcbiAgICBjb25zdCBpbnNlcnRlZEluZGV4ZXMgPSBbXTtcbiAgICBPYmplY3Qua2V5cyhzdWJtaXR0ZWRJbmRleGVzKS5mb3JFYWNoKG5hbWUgPT4ge1xuICAgICAgY29uc3QgZmllbGQgPSBzdWJtaXR0ZWRJbmRleGVzW25hbWVdO1xuICAgICAgaWYgKGV4aXN0aW5nSW5kZXhlc1tuYW1lXSAmJiBmaWVsZC5fX29wICE9PSAnRGVsZXRlJykge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSwgYEluZGV4ICR7bmFtZX0gZXhpc3RzLCBjYW5ub3QgdXBkYXRlLmApO1xuICAgICAgfVxuICAgICAgaWYgKCFleGlzdGluZ0luZGV4ZXNbbmFtZV0gJiYgZmllbGQuX19vcCA9PT0gJ0RlbGV0ZScpIHtcbiAgICAgICAgdGhyb3cgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgIFBhcnNlLkVycm9yLklOVkFMSURfUVVFUlksXG4gICAgICAgICAgYEluZGV4ICR7bmFtZX0gZG9lcyBub3QgZXhpc3QsIGNhbm5vdCBkZWxldGUuYFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgaWYgKGZpZWxkLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIGRlbGV0ZWRJbmRleGVzLnB1c2gobmFtZSk7XG4gICAgICAgIGRlbGV0ZSBleGlzdGluZ0luZGV4ZXNbbmFtZV07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBPYmplY3Qua2V5cyhmaWVsZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICF0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbiAmJlxuICAgICAgICAgICAgIU9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChmaWVsZHMsIGtleSlcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgICAgUGFyc2UuRXJyb3IuSU5WQUxJRF9RVUVSWSxcbiAgICAgICAgICAgICAgYEZpZWxkICR7a2V5fSBkb2VzIG5vdCBleGlzdCwgY2Fubm90IGFkZCBpbmRleC5gXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGV4aXN0aW5nSW5kZXhlc1tuYW1lXSA9IGZpZWxkO1xuICAgICAgICBpbnNlcnRlZEluZGV4ZXMucHVzaCh7XG4gICAgICAgICAga2V5OiBmaWVsZCxcbiAgICAgICAgICBuYW1lLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBhd2FpdCBjb25uLnR4KCdzZXQtaW5kZXhlcy13aXRoLXNjaGVtYS1mb3JtYXQnLCBhc3luYyB0ID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChpbnNlcnRlZEluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGF3YWl0IHNlbGYuY3JlYXRlSW5kZXhlcyhjbGFzc05hbWUsIGluc2VydGVkSW5kZXhlcywgdCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gcGctcHJvbWlzZSB1c2UgQmF0Y2ggZXJyb3Igc2VlIGh0dHBzOi8vZ2l0aHViLmNvbS92aXRhbHktdC9zcGV4L2Jsb2IvZTU3MjAzMGYyNjFiZTFhOGU5MzQxZmM2ZjYzN2UzNmFkMDdmNTIzMS9zcmMvZXJyb3JzL2JhdGNoLmpzI0w1OVxuICAgICAgICBjb25zdCBjb2x1bW5Eb2VzTm90RXhpc3RFcnJvciA9IGUuZ2V0RXJyb3JzICYmIGUuZ2V0RXJyb3JzKClbMF0gJiYgZS5nZXRFcnJvcnMoKVswXS5jb2RlID09PSAnNDI3MDMnO1xuICAgICAgICAvLyBTcGVjaWZpYyBjYXNlIHdoZW4gdGhlIGNvbHVtbiBkb2VzIG5vdCBleGlzdFxuICAgICAgICBpZiAoY29sdW1uRG9lc05vdEV4aXN0RXJyb3IpIHtcbiAgICAgICAgICAvLyBJZiB0aGUgZGlzYWJsZUluZGV4RmllbGRWYWxpZGF0aW9uIGlzIHRydWUsIHdlIHNob3VsZCBpZ25vcmUgdGhlIGVycm9yXG4gICAgICAgICAgaWYgKCF0aGlzLmRpc2FibGVJbmRleEZpZWxkVmFsaWRhdGlvbikge1xuICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGRlbGV0ZWRJbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgYXdhaXQgc2VsZi5kcm9wSW5kZXhlcyhjbGFzc05hbWUsIGRlbGV0ZWRJbmRleGVzLCB0KTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgJ1VQREFURSBcIl9TQ0hFTUFcIiBTRVQgJDI6bmFtZSA9IGpzb25fb2JqZWN0X3NldF9rZXkoJDI6bmFtZSwgJDM6OnRleHQsICQ0Ojpqc29uYikgV0hFUkUgXCJjbGFzc05hbWVcIiA9ICQxJyxcbiAgICAgICAgW2NsYXNzTmFtZSwgJ3NjaGVtYScsICdpbmRleGVzJywgSlNPTi5zdHJpbmdpZnkoZXhpc3RpbmdJbmRleGVzKV1cbiAgICAgICk7XG4gICAgfSk7XG4gICAgdGhpcy5fbm90aWZ5U2NoZW1hQ2hhbmdlKCk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVDbGFzcyhjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiA/YW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHBhcnNlU2NoZW1hID0gYXdhaXQgY29ublxuICAgICAgLnR4KCdjcmVhdGUtY2xhc3MnLCBhc3luYyB0ID0+IHtcbiAgICAgICAgYXdhaXQgdGhpcy5jcmVhdGVUYWJsZShjbGFzc05hbWUsIHNjaGVtYSwgdCk7XG4gICAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgICAnSU5TRVJUIElOVE8gXCJfU0NIRU1BXCIgKFwiY2xhc3NOYW1lXCIsIFwic2NoZW1hXCIsIFwiaXNQYXJzZUNsYXNzXCIpIFZBTFVFUyAoJDxjbGFzc05hbWU+LCAkPHNjaGVtYT4sIHRydWUpJyxcbiAgICAgICAgICB7IGNsYXNzTmFtZSwgc2NoZW1hIH1cbiAgICAgICAgKTtcbiAgICAgICAgYXdhaXQgdGhpcy5zZXRJbmRleGVzV2l0aFNjaGVtYUZvcm1hdChjbGFzc05hbWUsIHNjaGVtYS5pbmRleGVzLCB7fSwgc2NoZW1hLmZpZWxkcywgdCk7XG4gICAgICAgIHJldHVybiB0b1BhcnNlU2NoZW1hKHNjaGVtYSk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgIGlmIChlcnIuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yICYmIGVyci5kZXRhaWwuaW5jbHVkZXMoY2xhc3NOYW1lKSkge1xuICAgICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUsIGBDbGFzcyAke2NsYXNzTmFtZX0gYWxyZWFkeSBleGlzdHMuYCk7XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgfSk7XG4gICAgdGhpcy5fbm90aWZ5U2NoZW1hQ2hhbmdlKCk7XG4gICAgcmV0dXJuIHBhcnNlU2NoZW1hO1xuICB9XG5cbiAgLy8gSnVzdCBjcmVhdGUgYSB0YWJsZSwgZG8gbm90IGluc2VydCBpbiBzY2hlbWFcbiAgYXN5bmMgY3JlYXRlVGFibGUoY2xhc3NOYW1lOiBzdHJpbmcsIHNjaGVtYTogU2NoZW1hVHlwZSwgY29ubjogYW55KSB7XG4gICAgY29ubiA9IGNvbm4gfHwgdGhpcy5fY2xpZW50O1xuICAgIGRlYnVnKCdjcmVhdGVUYWJsZScpO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgY29uc3QgcGF0dGVybnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IGZpZWxkcyA9IE9iamVjdC5hc3NpZ24oe30sIHNjaGVtYS5maWVsZHMpO1xuICAgIGlmIChjbGFzc05hbWUgPT09ICdfVXNlcicpIHtcbiAgICAgIGZpZWxkcy5fZW1haWxfdmVyaWZ5X3Rva2VuX2V4cGlyZXNfYXQgPSB7IHR5cGU6ICdEYXRlJyB9O1xuICAgICAgZmllbGRzLl9lbWFpbF92ZXJpZnlfdG9rZW4gPSB7IHR5cGU6ICdTdHJpbmcnIH07XG4gICAgICBmaWVsZHMuX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fZmFpbGVkX2xvZ2luX2NvdW50ID0geyB0eXBlOiAnTnVtYmVyJyB9O1xuICAgICAgZmllbGRzLl9wZXJpc2hhYmxlX3Rva2VuID0geyB0eXBlOiAnU3RyaW5nJyB9O1xuICAgICAgZmllbGRzLl9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQgPSB7IHR5cGU6ICdEYXRlJyB9O1xuICAgICAgZmllbGRzLl9wYXNzd29yZF9jaGFuZ2VkX2F0ID0geyB0eXBlOiAnRGF0ZScgfTtcbiAgICAgIGZpZWxkcy5fcGFzc3dvcmRfaGlzdG9yeSA9IHsgdHlwZTogJ0FycmF5JyB9O1xuICAgIH1cbiAgICBsZXQgaW5kZXggPSAyO1xuICAgIGNvbnN0IHJlbGF0aW9ucyA9IFtdO1xuICAgIE9iamVjdC5rZXlzKGZpZWxkcykuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgY29uc3QgcGFyc2VUeXBlID0gZmllbGRzW2ZpZWxkTmFtZV07XG4gICAgICAvLyBTa2lwIHdoZW4gaXQncyBhIHJlbGF0aW9uXG4gICAgICAvLyBXZSdsbCBjcmVhdGUgdGhlIHRhYmxlcyBsYXRlclxuICAgICAgaWYgKHBhcnNlVHlwZS50eXBlID09PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHJlbGF0aW9ucy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChbJ19ycGVybScsICdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICBwYXJzZVR5cGUuY29udGVudHMgPSB7IHR5cGU6ICdTdHJpbmcnIH07XG4gICAgICB9XG4gICAgICB2YWx1ZXNBcnJheS5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICB2YWx1ZXNBcnJheS5wdXNoKHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlKHBhcnNlVHlwZSkpO1xuICAgICAgcGF0dGVybnNBcnJheS5wdXNoKGAkJHtpbmRleH06bmFtZSAkJHtpbmRleCArIDF9OnJhd2ApO1xuICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ29iamVjdElkJykge1xuICAgICAgICBwYXR0ZXJuc0FycmF5LnB1c2goYFBSSU1BUlkgS0VZICgkJHtpbmRleH06bmFtZSlgKTtcbiAgICAgIH1cbiAgICAgIGluZGV4ID0gaW5kZXggKyAyO1xuICAgIH0pO1xuICAgIGNvbnN0IHFzID0gYENSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTICQxOm5hbWUgKCR7cGF0dGVybnNBcnJheS5qb2luKCl9KWA7XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgLi4udmFsdWVzQXJyYXldO1xuXG4gICAgcmV0dXJuIGNvbm4udGFzaygnY3JlYXRlLXRhYmxlJywgYXN5bmMgdCA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCB0Lm5vbmUocXMsIHZhbHVlcyk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNEdXBsaWNhdGVSZWxhdGlvbkVycm9yKSB7XG4gICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICAgICAgLy8gRUxTRTogVGFibGUgYWxyZWFkeSBleGlzdHMsIG11c3QgaGF2ZSBiZWVuIGNyZWF0ZWQgYnkgYSBkaWZmZXJlbnQgcmVxdWVzdC4gSWdub3JlIHRoZSBlcnJvci5cbiAgICAgIH1cbiAgICAgIGF3YWl0IHQudHgoJ2NyZWF0ZS10YWJsZS10eCcsIHR4ID0+IHtcbiAgICAgICAgcmV0dXJuIHR4LmJhdGNoKFxuICAgICAgICAgIHJlbGF0aW9ucy5tYXAoZmllbGROYW1lID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0eC5ub25lKFxuICAgICAgICAgICAgICAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgJDxqb2luVGFibGU6bmFtZT4gKFwicmVsYXRlZElkXCIgdmFyQ2hhcigxMjApLCBcIm93bmluZ0lkXCIgdmFyQ2hhcigxMjApLCBQUklNQVJZIEtFWShcInJlbGF0ZWRJZFwiLCBcIm93bmluZ0lkXCIpICknLFxuICAgICAgICAgICAgICB7IGpvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSlcbiAgICAgICAgKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgYXN5bmMgc2NoZW1hVXBncmFkZShjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBjb25uOiBhbnkpIHtcbiAgICBkZWJ1Zygnc2NoZW1hVXBncmFkZScpO1xuICAgIGNvbm4gPSBjb25uIHx8IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcblxuICAgIGF3YWl0IGNvbm4udGFzaygnc2NoZW1hLXVwZ3JhZGUnLCBhc3luYyB0ID0+IHtcbiAgICAgIGNvbnN0IGNvbHVtbnMgPSBhd2FpdCB0Lm1hcChcbiAgICAgICAgJ1NFTEVDVCBjb2x1bW5fbmFtZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFdIRVJFIHRhYmxlX25hbWUgPSAkPGNsYXNzTmFtZT4nLFxuICAgICAgICB7IGNsYXNzTmFtZSB9LFxuICAgICAgICBhID0+IGEuY29sdW1uX25hbWVcbiAgICAgICk7XG4gICAgICBjb25zdCBuZXdDb2x1bW5zID0gT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcylcbiAgICAgICAgLmZpbHRlcihpdGVtID0+IGNvbHVtbnMuaW5kZXhPZihpdGVtKSA9PT0gLTEpXG4gICAgICAgIC5tYXAoZmllbGROYW1lID0+IHNlbGYuYWRkRmllbGRJZk5vdEV4aXN0cyhjbGFzc05hbWUsIGZpZWxkTmFtZSwgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdKSk7XG5cbiAgICAgIGF3YWl0IHQuYmF0Y2gobmV3Q29sdW1ucyk7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBhZGRGaWVsZElmTm90RXhpc3RzKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgLy8gVE9ETzogTXVzdCBiZSByZXZpc2VkIGZvciBpbnZhbGlkIGxvZ2ljLi4uXG4gICAgZGVidWcoJ2FkZEZpZWxkSWZOb3RFeGlzdHMnKTtcbiAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICBhd2FpdCB0aGlzLl9jbGllbnQudHgoJ2FkZC1maWVsZC1pZi1ub3QtZXhpc3RzJywgYXN5bmMgdCA9PiB7XG4gICAgICBpZiAodHlwZS50eXBlICE9PSAnUmVsYXRpb24nKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKFxuICAgICAgICAgICAgJ0FMVEVSIFRBQkxFICQ8Y2xhc3NOYW1lOm5hbWU+IEFERCBDT0xVTU4gSUYgTk9UIEVYSVNUUyAkPGZpZWxkTmFtZTpuYW1lPiAkPHBvc3RncmVzVHlwZTpyYXc+JyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgIHBvc3RncmVzVHlwZTogcGFyc2VUeXBlVG9Qb3N0Z3Jlc1R5cGUodHlwZSksXG4gICAgICAgICAgICB9XG4gICAgICAgICAgKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gc2VsZi5jcmVhdGVDbGFzcyhjbGFzc05hbWUsIHsgZmllbGRzOiB7IFtmaWVsZE5hbWVdOiB0eXBlIH0gfSwgdCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc0R1cGxpY2F0ZUNvbHVtbkVycm9yKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQ29sdW1uIGFscmVhZHkgZXhpc3RzLCBjcmVhdGVkIGJ5IG90aGVyIHJlcXVlc3QuIENhcnJ5IG9uIHRvIHNlZSBpZiBpdCdzIHRoZSByaWdodCB0eXBlLlxuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhd2FpdCB0Lm5vbmUoXG4gICAgICAgICAgJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTICQ8am9pblRhYmxlOm5hbWU+IChcInJlbGF0ZWRJZFwiIHZhckNoYXIoMTIwKSwgXCJvd25pbmdJZFwiIHZhckNoYXIoMTIwKSwgUFJJTUFSWSBLRVkoXCJyZWxhdGVkSWRcIiwgXCJvd25pbmdJZFwiKSApJyxcbiAgICAgICAgICB7IGpvaW5UYWJsZTogYF9Kb2luOiR7ZmllbGROYW1lfToke2NsYXNzTmFtZX1gIH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdC5hbnkoXG4gICAgICAgICdTRUxFQ1QgXCJzY2hlbWFcIiBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkPGNsYXNzTmFtZT4gYW5kIChcInNjaGVtYVwiOjpqc29uLT5cXCdmaWVsZHNcXCctPiQ8ZmllbGROYW1lPikgaXMgbm90IG51bGwnLFxuICAgICAgICB7IGNsYXNzTmFtZSwgZmllbGROYW1lIH1cbiAgICAgICk7XG5cbiAgICAgIGlmIChyZXN1bHRbMF0pIHtcbiAgICAgICAgdGhyb3cgJ0F0dGVtcHRlZCB0byBhZGQgYSBmaWVsZCB0aGF0IGFscmVhZHkgZXhpc3RzJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IHBhdGggPSBge2ZpZWxkcywke2ZpZWxkTmFtZX19YDtcbiAgICAgICAgYXdhaXQgdC5ub25lKFxuICAgICAgICAgICdVUERBVEUgXCJfU0NIRU1BXCIgU0VUIFwic2NoZW1hXCI9anNvbmJfc2V0KFwic2NoZW1hXCIsICQ8cGF0aD4sICQ8dHlwZT4pICBXSEVSRSBcImNsYXNzTmFtZVwiPSQ8Y2xhc3NOYW1lPicsXG4gICAgICAgICAgeyBwYXRoLCB0eXBlLCBjbGFzc05hbWUgfVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHRoaXMuX25vdGlmeVNjaGVtYUNoYW5nZSgpO1xuICB9XG5cbiAgYXN5bmMgdXBkYXRlRmllbGRPcHRpb25zKGNsYXNzTmFtZTogc3RyaW5nLCBmaWVsZE5hbWU6IHN0cmluZywgdHlwZTogYW55KSB7XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50LnR4KCd1cGRhdGUtc2NoZW1hLWZpZWxkLW9wdGlvbnMnLCBhc3luYyB0ID0+IHtcbiAgICAgIGNvbnN0IHBhdGggPSBge2ZpZWxkcywke2ZpZWxkTmFtZX19YDtcbiAgICAgIGF3YWl0IHQubm9uZShcbiAgICAgICAgJ1VQREFURSBcIl9TQ0hFTUFcIiBTRVQgXCJzY2hlbWFcIj1qc29uYl9zZXQoXCJzY2hlbWFcIiwgJDxwYXRoPiwgJDx0eXBlPikgIFdIRVJFIFwiY2xhc3NOYW1lXCI9JDxjbGFzc05hbWU+JyxcbiAgICAgICAgeyBwYXRoLCB0eXBlLCBjbGFzc05hbWUgfVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIERyb3BzIGEgY29sbGVjdGlvbi4gUmVzb2x2ZXMgd2l0aCB0cnVlIGlmIGl0IHdhcyBhIFBhcnNlIFNjaGVtYSAoZWcuIF9Vc2VyLCBDdXN0b20sIGV0Yy4pXG4gIC8vIGFuZCByZXNvbHZlcyB3aXRoIGZhbHNlIGlmIGl0IHdhc24ndCAoZWcuIGEgam9pbiB0YWJsZSkuIFJlamVjdHMgaWYgZGVsZXRpb24gd2FzIGltcG9zc2libGUuXG4gIGFzeW5jIGRlbGV0ZUNsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3Qgb3BlcmF0aW9ucyA9IFtcbiAgICAgIHsgcXVlcnk6IGBEUk9QIFRBQkxFIElGIEVYSVNUUyAkMTpuYW1lYCwgdmFsdWVzOiBbY2xhc3NOYW1lXSB9LFxuICAgICAge1xuICAgICAgICBxdWVyeTogYERFTEVURSBGUk9NIFwiX1NDSEVNQVwiIFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkMWAsXG4gICAgICAgIHZhbHVlczogW2NsYXNzTmFtZV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCB0aGlzLl9jbGllbnRcbiAgICAgIC50eCh0ID0+IHQubm9uZSh0aGlzLl9wZ3AuaGVscGVycy5jb25jYXQob3BlcmF0aW9ucykpKVxuICAgICAgLnRoZW4oKCkgPT4gY2xhc3NOYW1lLmluZGV4T2YoJ19Kb2luOicpICE9IDApOyAvLyByZXNvbHZlcyB3aXRoIGZhbHNlIHdoZW4gX0pvaW4gdGFibGVcblxuICAgIHRoaXMuX25vdGlmeVNjaGVtYUNoYW5nZSgpO1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuXG4gIC8vIERlbGV0ZSBhbGwgZGF0YSBrbm93biB0byB0aGlzIGFkYXB0ZXIuIFVzZWQgZm9yIHRlc3RpbmcuXG4gIGFzeW5jIGRlbGV0ZUFsbENsYXNzZXMoKSB7XG4gICAgY29uc3Qgbm93ID0gbmV3IERhdGUoKS5nZXRUaW1lKCk7XG4gICAgY29uc3QgaGVscGVycyA9IHRoaXMuX3BncC5oZWxwZXJzO1xuICAgIGRlYnVnKCdkZWxldGVBbGxDbGFzc2VzJyk7XG4gICAgaWYgKHRoaXMuX2NsaWVudD8uJHBvb2wuZW5kZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50XG4gICAgICAudGFzaygnZGVsZXRlLWFsbC1jbGFzc2VzJywgYXN5bmMgdCA9PiB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IHQuYW55KCdTRUxFQ1QgKiBGUk9NIFwiX1NDSEVNQVwiJyk7XG4gICAgICAgICAgY29uc3Qgam9pbnMgPSByZXN1bHRzLnJlZHVjZSgobGlzdDogQXJyYXk8c3RyaW5nPiwgc2NoZW1hOiBhbnkpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBsaXN0LmNvbmNhdChqb2luVGFibGVzRm9yU2NoZW1hKHNjaGVtYS5zY2hlbWEpKTtcbiAgICAgICAgICB9LCBbXSk7XG4gICAgICAgICAgY29uc3QgY2xhc3NlcyA9IFtcbiAgICAgICAgICAgICdfU0NIRU1BJyxcbiAgICAgICAgICAgICdfUHVzaFN0YXR1cycsXG4gICAgICAgICAgICAnX0pvYlN0YXR1cycsXG4gICAgICAgICAgICAnX0pvYlNjaGVkdWxlJyxcbiAgICAgICAgICAgICdfSG9va3MnLFxuICAgICAgICAgICAgJ19HbG9iYWxDb25maWcnLFxuICAgICAgICAgICAgJ19HcmFwaFFMQ29uZmlnJyxcbiAgICAgICAgICAgICdfQXVkaWVuY2UnLFxuICAgICAgICAgICAgJ19JZGVtcG90ZW5jeScsXG4gICAgICAgICAgICAuLi5yZXN1bHRzLm1hcChyZXN1bHQgPT4gcmVzdWx0LmNsYXNzTmFtZSksXG4gICAgICAgICAgICAuLi5qb2lucyxcbiAgICAgICAgICBdO1xuICAgICAgICAgIGNvbnN0IHF1ZXJpZXMgPSBjbGFzc2VzLm1hcChjbGFzc05hbWUgPT4gKHtcbiAgICAgICAgICAgIHF1ZXJ5OiAnRFJPUCBUQUJMRSBJRiBFWElTVFMgJDxjbGFzc05hbWU6bmFtZT4nLFxuICAgICAgICAgICAgdmFsdWVzOiB7IGNsYXNzTmFtZSB9LFxuICAgICAgICAgIH0pKTtcbiAgICAgICAgICBhd2FpdCB0LnR4KHR4ID0+IHR4Lm5vbmUoaGVscGVycy5jb25jYXQocXVlcmllcykpKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSAhPT0gUG9zdGdyZXNSZWxhdGlvbkRvZXNOb3RFeGlzdEVycm9yKSB7XG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gTm8gX1NDSEVNQSBjb2xsZWN0aW9uLiBEb24ndCBkZWxldGUgYW55dGhpbmcuXG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGRlYnVnKGBkZWxldGVBbGxDbGFzc2VzIGRvbmUgaW4gJHtuZXcgRGF0ZSgpLmdldFRpbWUoKSAtIG5vd31gKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgLy8gUmVtb3ZlIHRoZSBjb2x1bW4gYW5kIGFsbCB0aGUgZGF0YS4gRm9yIFJlbGF0aW9ucywgdGhlIF9Kb2luIGNvbGxlY3Rpb24gaXMgaGFuZGxlZFxuICAvLyBzcGVjaWFsbHksIHRoaXMgZnVuY3Rpb24gZG9lcyBub3QgZGVsZXRlIF9Kb2luIGNvbHVtbnMuIEl0IHNob3VsZCwgaG93ZXZlciwgaW5kaWNhdGVcbiAgLy8gdGhhdCB0aGUgcmVsYXRpb24gZmllbGRzIGRvZXMgbm90IGV4aXN0IGFueW1vcmUuIEluIG1vbmdvLCB0aGlzIG1lYW5zIHJlbW92aW5nIGl0IGZyb21cbiAgLy8gdGhlIF9TQ0hFTUEgY29sbGVjdGlvbi4gIFRoZXJlIHNob3VsZCBiZSBubyBhY3R1YWwgZGF0YSBpbiB0aGUgY29sbGVjdGlvbiB1bmRlciB0aGUgc2FtZSBuYW1lXG4gIC8vIGFzIHRoZSByZWxhdGlvbiBjb2x1bW4sIHNvIGl0J3MgZmluZSB0byBhdHRlbXB0IHRvIGRlbGV0ZSBpdC4gSWYgdGhlIGZpZWxkcyBsaXN0ZWQgdG8gYmVcbiAgLy8gZGVsZXRlZCBkbyBub3QgZXhpc3QsIHRoaXMgZnVuY3Rpb24gc2hvdWxkIHJldHVybiBzdWNjZXNzZnVsbHkgYW55d2F5cy4gQ2hlY2tpbmcgZm9yXG4gIC8vIGF0dGVtcHRzIHRvIGRlbGV0ZSBub24tZXhpc3RlbnQgZmllbGRzIGlzIHRoZSByZXNwb25zaWJpbGl0eSBvZiBQYXJzZSBTZXJ2ZXIuXG5cbiAgLy8gVGhpcyBmdW5jdGlvbiBpcyBub3Qgb2JsaWdhdGVkIHRvIGRlbGV0ZSBmaWVsZHMgYXRvbWljYWxseS4gSXQgaXMgZ2l2ZW4gdGhlIGZpZWxkXG4gIC8vIG5hbWVzIGluIGEgbGlzdCBzbyB0aGF0IGRhdGFiYXNlcyB0aGF0IGFyZSBjYXBhYmxlIG9mIGRlbGV0aW5nIGZpZWxkcyBhdG9taWNhbGx5XG4gIC8vIG1heSBkbyBzby5cblxuICAvLyBSZXR1cm5zIGEgUHJvbWlzZS5cbiAgYXN5bmMgZGVsZXRlRmllbGRzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIGZpZWxkTmFtZXM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgZGVidWcoJ2RlbGV0ZUZpZWxkcycpO1xuICAgIGZpZWxkTmFtZXMgPSBmaWVsZE5hbWVzLnJlZHVjZSgobGlzdDogQXJyYXk8c3RyaW5nPiwgZmllbGROYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkID0gc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgaWYgKGZpZWxkLnR5cGUgIT09ICdSZWxhdGlvbicpIHtcbiAgICAgICAgbGlzdC5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICB9XG4gICAgICBkZWxldGUgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdO1xuICAgICAgcmV0dXJuIGxpc3Q7XG4gICAgfSwgW10pO1xuXG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZSwgLi4uZmllbGROYW1lc107XG4gICAgY29uc3QgY29sdW1ucyA9IGZpZWxkTmFtZXNcbiAgICAgIC5tYXAoKG5hbWUsIGlkeCkgPT4ge1xuICAgICAgICByZXR1cm4gYCQke2lkeCArIDJ9Om5hbWVgO1xuICAgICAgfSlcbiAgICAgIC5qb2luKCcsIERST1AgQ09MVU1OJyk7XG5cbiAgICBhd2FpdCB0aGlzLl9jbGllbnQudHgoJ2RlbGV0ZS1maWVsZHMnLCBhc3luYyB0ID0+IHtcbiAgICAgIGF3YWl0IHQubm9uZSgnVVBEQVRFIFwiX1NDSEVNQVwiIFNFVCBcInNjaGVtYVwiID0gJDxzY2hlbWE+IFdIRVJFIFwiY2xhc3NOYW1lXCIgPSAkPGNsYXNzTmFtZT4nLCB7XG4gICAgICAgIHNjaGVtYSxcbiAgICAgICAgY2xhc3NOYW1lLFxuICAgICAgfSk7XG4gICAgICBpZiAodmFsdWVzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgYXdhaXQgdC5ub25lKGBBTFRFUiBUQUJMRSAkMTpuYW1lIERST1AgQ09MVU1OIElGIEVYSVNUUyAke2NvbHVtbnN9YCwgdmFsdWVzKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0aGlzLl9ub3RpZnlTY2hlbWFDaGFuZ2UoKTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIGFsbCBzY2hlbWFzIGtub3duIHRvIHRoaXMgYWRhcHRlciwgaW4gUGFyc2UgZm9ybWF0LiBJbiBjYXNlIHRoZVxuICAvLyBzY2hlbWFzIGNhbm5vdCBiZSByZXRyaWV2ZWQsIHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVqZWN0cy4gUmVxdWlyZW1lbnRzIGZvciB0aGVcbiAgLy8gcmVqZWN0aW9uIHJlYXNvbiBhcmUgVEJELlxuICBhc3luYyBnZXRBbGxDbGFzc2VzKCkge1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQudGFzaygnZ2V0LWFsbC1jbGFzc2VzJywgYXN5bmMgdCA9PiB7XG4gICAgICByZXR1cm4gYXdhaXQgdC5tYXAoJ1NFTEVDVCAqIEZST00gXCJfU0NIRU1BXCInLCBudWxsLCByb3cgPT5cbiAgICAgICAgdG9QYXJzZVNjaGVtYSh7IGNsYXNzTmFtZTogcm93LmNsYXNzTmFtZSwgLi4ucm93LnNjaGVtYSB9KVxuICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFJldHVybiBhIHByb21pc2UgZm9yIHRoZSBzY2hlbWEgd2l0aCB0aGUgZ2l2ZW4gbmFtZSwgaW4gUGFyc2UgZm9ybWF0LiBJZlxuICAvLyB0aGlzIGFkYXB0ZXIgZG9lc24ndCBrbm93IGFib3V0IHRoZSBzY2hlbWEsIHJldHVybiBhIHByb21pc2UgdGhhdCByZWplY3RzIHdpdGhcbiAgLy8gdW5kZWZpbmVkIGFzIHRoZSByZWFzb24uXG4gIGFzeW5jIGdldENsYXNzKGNsYXNzTmFtZTogc3RyaW5nKSB7XG4gICAgZGVidWcoJ2dldENsYXNzJyk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLmFueSgnU0VMRUNUICogRlJPTSBcIl9TQ0hFTUFcIiBXSEVSRSBcImNsYXNzTmFtZVwiID0gJDxjbGFzc05hbWU+Jywge1xuICAgICAgICBjbGFzc05hbWUsXG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKHJlc3VsdC5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgICB0aHJvdyB1bmRlZmluZWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdFswXS5zY2hlbWE7XG4gICAgICB9KVxuICAgICAgLnRoZW4odG9QYXJzZVNjaGVtYSk7XG4gIH1cblxuICAvLyBUT0RPOiByZW1vdmUgdGhlIG1vbmdvIGZvcm1hdCBkZXBlbmRlbmN5IGluIHRoZSByZXR1cm4gdmFsdWVcbiAgYXN5bmMgY3JlYXRlT2JqZWN0KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBvYmplY3Q6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBkZWJ1ZygnY3JlYXRlT2JqZWN0Jyk7XG4gICAgbGV0IGNvbHVtbnNBcnJheSA9IFtdO1xuICAgIGNvbnN0IHZhbHVlc0FycmF5ID0gW107XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuICAgIGNvbnN0IGdlb1BvaW50cyA9IHt9O1xuXG4gICAgb2JqZWN0ID0gaGFuZGxlRG90RmllbGRzKG9iamVjdCk7XG5cbiAgICB2YWxpZGF0ZUtleXMob2JqZWN0KTtcblxuICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmaWVsZE5hbWUgPT4ge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBhdXRoRGF0YU1hdGNoID0gZmllbGROYW1lLm1hdGNoKC9eX2F1dGhfZGF0YV8oW2EtekEtWjAtOV9dKykkLyk7XG4gICAgICBjb25zdCBhdXRoRGF0YUFscmVhZHlFeGlzdHMgPSAhIW9iamVjdC5hdXRoRGF0YTtcbiAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgIG9iamVjdFsnYXV0aERhdGEnXSA9IG9iamVjdFsnYXV0aERhdGEnXSB8fCB7fTtcbiAgICAgICAgb2JqZWN0WydhdXRoRGF0YSddW3Byb3ZpZGVyXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICBkZWxldGUgb2JqZWN0W2ZpZWxkTmFtZV07XG4gICAgICAgIGZpZWxkTmFtZSA9ICdhdXRoRGF0YSc7XG4gICAgICAgIC8vIEF2b2lkIGFkZGluZyBhdXRoRGF0YSBtdWx0aXBsZSB0aW1lcyB0byB0aGUgcXVlcnlcbiAgICAgICAgaWYgKGF1dGhEYXRhQWxyZWFkeUV4aXN0cykge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb2x1bW5zQXJyYXkucHVzaChmaWVsZE5hbWUpO1xuICAgICAgaWYgKCFzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiYgY2xhc3NOYW1lID09PSAnX1VzZXInKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBmaWVsZE5hbWUgPT09ICdfZW1haWxfdmVyaWZ5X3Rva2VuJyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19mYWlsZWRfbG9naW5fY291bnQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3BlcmlzaGFibGVfdG9rZW4nIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2hpc3RvcnknXG4gICAgICAgICkge1xuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGZpZWxkTmFtZSA9PT0gJ19lbWFpbF92ZXJpZnlfdG9rZW5fZXhwaXJlc19hdCcpIHtcbiAgICAgICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0uaXNvKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChudWxsKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXG4gICAgICAgICAgZmllbGROYW1lID09PSAnX2FjY291bnRfbG9ja291dF9leHBpcmVzX2F0JyB8fFxuICAgICAgICAgIGZpZWxkTmFtZSA9PT0gJ19wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQnIHx8XG4gICAgICAgICAgZmllbGROYW1lID09PSAnX3Bhc3N3b3JkX2NoYW5nZWRfYXQnXG4gICAgICAgICkge1xuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBzd2l0Y2ggKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlKSB7XG4gICAgICAgIGNhc2UgJ0RhdGUnOlxuICAgICAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSkge1xuICAgICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5pc28pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG51bGwpO1xuICAgICAgICAgIH1cbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnUG9pbnRlcic6XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaChvYmplY3RbZmllbGROYW1lXS5vYmplY3RJZCk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgJ0FycmF5JzpcbiAgICAgICAgICBpZiAoWydfcnBlcm0nLCAnX3dwZXJtJ10uaW5kZXhPZihmaWVsZE5hbWUpID49IDApIHtcbiAgICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKEpTT04uc3RyaW5naWZ5KG9iamVjdFtmaWVsZE5hbWVdKSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdPYmplY3QnOlxuICAgICAgICBjYXNlICdCeXRlcyc6XG4gICAgICAgIGNhc2UgJ1N0cmluZyc6XG4gICAgICAgIGNhc2UgJ051bWJlcic6XG4gICAgICAgIGNhc2UgJ0Jvb2xlYW4nOlxuICAgICAgICAgIHZhbHVlc0FycmF5LnB1c2gob2JqZWN0W2ZpZWxkTmFtZV0pO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdGaWxlJzpcbiAgICAgICAgICB2YWx1ZXNBcnJheS5wdXNoKG9iamVjdFtmaWVsZE5hbWVdLm5hbWUpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdQb2x5Z29uJzoge1xuICAgICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChvYmplY3RbZmllbGROYW1lXS5jb29yZGluYXRlcyk7XG4gICAgICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgY2FzZSAnR2VvUG9pbnQnOlxuICAgICAgICAgIC8vIHBvcCB0aGUgcG9pbnQgYW5kIHByb2Nlc3MgbGF0ZXJcbiAgICAgICAgICBnZW9Qb2ludHNbZmllbGROYW1lXSA9IG9iamVjdFtmaWVsZE5hbWVdO1xuICAgICAgICAgIGNvbHVtbnNBcnJheS5wb3AoKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBgVHlwZSAke3NjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlfSBub3Qgc3VwcG9ydGVkIHlldGA7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBjb2x1bW5zQXJyYXkgPSBjb2x1bW5zQXJyYXkuY29uY2F0KE9iamVjdC5rZXlzKGdlb1BvaW50cykpO1xuICAgIGNvbnN0IGluaXRpYWxWYWx1ZXMgPSB2YWx1ZXNBcnJheS5tYXAoKHZhbCwgaW5kZXgpID0+IHtcbiAgICAgIGxldCB0ZXJtaW5hdGlvbiA9ICcnO1xuICAgICAgY29uc3QgZmllbGROYW1lID0gY29sdW1uc0FycmF5W2luZGV4XTtcbiAgICAgIGlmIChbJ19ycGVybScsICdfd3Blcm0nXS5pbmRleE9mKGZpZWxkTmFtZSkgPj0gMCkge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6OnRleHRbXSc7XG4gICAgICB9IGVsc2UgaWYgKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5Jykge1xuICAgICAgICB0ZXJtaW5hdGlvbiA9ICc6Ompzb25iJztcbiAgICAgIH1cbiAgICAgIHJldHVybiBgJCR7aW5kZXggKyAyICsgY29sdW1uc0FycmF5Lmxlbmd0aH0ke3Rlcm1pbmF0aW9ufWA7XG4gICAgfSk7XG4gICAgY29uc3QgZ2VvUG9pbnRzSW5qZWN0cyA9IE9iamVjdC5rZXlzKGdlb1BvaW50cykubWFwKGtleSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGdlb1BvaW50c1trZXldO1xuICAgICAgdmFsdWVzQXJyYXkucHVzaCh2YWx1ZS5sb25naXR1ZGUsIHZhbHVlLmxhdGl0dWRlKTtcbiAgICAgIGNvbnN0IGwgPSB2YWx1ZXNBcnJheS5sZW5ndGggKyBjb2x1bW5zQXJyYXkubGVuZ3RoO1xuICAgICAgcmV0dXJuIGBQT0lOVCgkJHtsfSwgJCR7bCArIDF9KWA7XG4gICAgfSk7XG5cbiAgICBjb25zdCBjb2x1bW5zUGF0dGVybiA9IGNvbHVtbnNBcnJheS5tYXAoKGNvbCwgaW5kZXgpID0+IGAkJHtpbmRleCArIDJ9Om5hbWVgKS5qb2luKCk7XG4gICAgY29uc3QgdmFsdWVzUGF0dGVybiA9IGluaXRpYWxWYWx1ZXMuY29uY2F0KGdlb1BvaW50c0luamVjdHMpLmpvaW4oKTtcblxuICAgIGNvbnN0IHFzID0gYElOU0VSVCBJTlRPICQxOm5hbWUgKCR7Y29sdW1uc1BhdHRlcm59KSBWQUxVRVMgKCR7dmFsdWVzUGF0dGVybn0pYDtcbiAgICBjb25zdCB2YWx1ZXMgPSBbY2xhc3NOYW1lLCAuLi5jb2x1bW5zQXJyYXksIC4uLnZhbHVlc0FycmF5XTtcbiAgICBjb25zdCBwcm9taXNlID0gKHRyYW5zYWN0aW9uYWxTZXNzaW9uID8gdHJhbnNhY3Rpb25hbFNlc3Npb24udCA6IHRoaXMuX2NsaWVudClcbiAgICAgIC5ub25lKHFzLCB2YWx1ZXMpXG4gICAgICAudGhlbigoKSA9PiAoeyBvcHM6IFtvYmplY3RdIH0pKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvcikge1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5jb25zdHJhaW50KSB7XG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgYXV0aERhdGEgdW5pcXVlIGluZGV4IHZpb2xhdGlvbnMgZmlyc3RcbiAgICAgICAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBlcnJvci5jb25zdHJhaW50Lm1hdGNoKC9fVXNlcl91bmlxdWVfYXV0aERhdGFfKFthLXpBLVowLTlfXSspX2lkLyk7XG4gICAgICAgICAgICBpZiAoYXV0aERhdGFNYXRjaCkge1xuICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IGBfYXV0aF9kYXRhXyR7YXV0aERhdGFNYXRjaFsxXX1gIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gZXJyb3IuY29uc3RyYWludC5tYXRjaCgvdW5pcXVlXyhbYS16QS1aXSspLyk7XG4gICAgICAgICAgICAgIGlmIChtYXRjaGVzICYmIEFycmF5LmlzQXJyYXkobWF0Y2hlcykpIHtcbiAgICAgICAgICAgICAgICBlcnIudXNlckluZm8gPSB7IGR1cGxpY2F0ZWRfZmllbGQ6IG1hdGNoZXNbMV0gfTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBlcnJvciA9IGVycjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pO1xuICAgIGlmICh0cmFuc2FjdGlvbmFsU2Vzc2lvbikge1xuICAgICAgdHJhbnNhY3Rpb25hbFNlc3Npb24uYmF0Y2gucHVzaChwcm9taXNlKTtcbiAgICB9XG4gICAgcmV0dXJuIHByb21pc2U7XG4gIH1cblxuICAvLyBSZW1vdmUgYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIC8vIElmIG5vIG9iamVjdHMgbWF0Y2gsIHJlamVjdCB3aXRoIE9CSkVDVF9OT1RfRk9VTkQuIElmIG9iamVjdHMgYXJlIGZvdW5kIGFuZCBkZWxldGVkLCByZXNvbHZlIHdpdGggdW5kZWZpbmVkLlxuICAvLyBJZiB0aGVyZSBpcyBzb21lIG90aGVyIGVycm9yLCByZWplY3Qgd2l0aCBJTlRFUk5BTF9TRVJWRVJfRVJST1IuXG4gIGFzeW5jIGRlbGV0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICkge1xuICAgIGRlYnVnKCdkZWxldGVPYmplY3RzQnlRdWVyeScpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IGluZGV4ID0gMjtcbiAgICBjb25zdCB3aGVyZSA9IGJ1aWxkV2hlcmVDbGF1c2Uoe1xuICAgICAgc2NoZW1hLFxuICAgICAgaW5kZXgsXG4gICAgICBxdWVyeSxcbiAgICAgIGNhc2VJbnNlbnNpdGl2ZTogZmFsc2UsXG4gICAgfSk7XG4gICAgdmFsdWVzLnB1c2goLi4ud2hlcmUudmFsdWVzKTtcbiAgICBpZiAoT2JqZWN0LmtleXMocXVlcnkpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgd2hlcmUucGF0dGVybiA9ICdUUlVFJztcbiAgICB9XG4gICAgY29uc3QgcXMgPSBgV0lUSCBkZWxldGVkIEFTIChERUxFVEUgRlJPTSAkMTpuYW1lIFdIRVJFICR7d2hlcmUucGF0dGVybn0gUkVUVVJOSU5HICopIFNFTEVDVCBjb3VudCgqKSBGUk9NIGRlbGV0ZWRgO1xuICAgIGNvbnN0IHByb21pc2UgPSAodHJhbnNhY3Rpb25hbFNlc3Npb24gPyB0cmFuc2FjdGlvbmFsU2Vzc2lvbi50IDogdGhpcy5fY2xpZW50KVxuICAgICAgLm9uZShxcywgdmFsdWVzLCBhID0+ICthLmNvdW50KVxuICAgICAgLnRoZW4oY291bnQgPT4ge1xuICAgICAgICBpZiAoY291bnQgPT09IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuT0JKRUNUX05PVF9GT1VORCwgJ09iamVjdCBub3QgZm91bmQuJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmV0dXJuIGNvdW50O1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgIT09IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvcikge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIC8vIEVMU0U6IERvbid0IGRlbGV0ZSBhbnl0aGluZyBpZiBkb2Vzbid0IGV4aXN0XG4gICAgICB9KTtcbiAgICBpZiAodHJhbnNhY3Rpb25hbFNlc3Npb24pIHtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLmJhdGNoLnB1c2gocHJvbWlzZSk7XG4gICAgfVxuICAgIHJldHVybiBwcm9taXNlO1xuICB9XG4gIC8vIFJldHVybiB2YWx1ZSBub3QgY3VycmVudGx5IHdlbGwgc3BlY2lmaWVkLlxuICBhc3luYyBmaW5kT25lQW5kVXBkYXRlKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgZGVidWcoJ2ZpbmRPbmVBbmRVcGRhdGUnKTtcbiAgICByZXR1cm4gdGhpcy51cGRhdGVPYmplY3RzQnlRdWVyeShjbGFzc05hbWUsIHNjaGVtYSwgcXVlcnksIHVwZGF0ZSwgdHJhbnNhY3Rpb25hbFNlc3Npb24pLnRoZW4oXG4gICAgICB2YWwgPT4gdmFsWzBdXG4gICAgKTtcbiAgfVxuXG4gIC8vIEFwcGx5IHRoZSB1cGRhdGUgdG8gYWxsIG9iamVjdHMgdGhhdCBtYXRjaCB0aGUgZ2l2ZW4gUGFyc2UgUXVlcnkuXG4gIGFzeW5jIHVwZGF0ZU9iamVjdHNCeVF1ZXJ5KFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHVwZGF0ZTogYW55LFxuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uOiA/YW55XG4gICk6IFByb21pc2U8W2FueV0+IHtcbiAgICBkZWJ1ZygndXBkYXRlT2JqZWN0c0J5UXVlcnknKTtcbiAgICBjb25zdCB1cGRhdGVQYXR0ZXJucyA9IFtdO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGxldCBpbmRleCA9IDI7XG4gICAgc2NoZW1hID0gdG9Qb3N0Z3Jlc1NjaGVtYShzY2hlbWEpO1xuXG4gICAgY29uc3Qgb3JpZ2luYWxVcGRhdGUgPSB7IC4uLnVwZGF0ZSB9O1xuXG4gICAgLy8gU2V0IGZsYWcgZm9yIGRvdCBub3RhdGlvbiBmaWVsZHNcbiAgICBjb25zdCBkb3ROb3RhdGlvbk9wdGlvbnMgPSB7fTtcbiAgICBPYmplY3Qua2V5cyh1cGRhdGUpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChmaWVsZE5hbWUuaW5kZXhPZignLicpID4gLTEpIHtcbiAgICAgICAgY29uc3QgY29tcG9uZW50cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBjb25zdCBmaXJzdCA9IGNvbXBvbmVudHMuc2hpZnQoKTtcbiAgICAgICAgZG90Tm90YXRpb25PcHRpb25zW2ZpcnN0XSA9IHRydWU7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBkb3ROb3RhdGlvbk9wdGlvbnNbZmllbGROYW1lXSA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHVwZGF0ZSA9IGhhbmRsZURvdEZpZWxkcyh1cGRhdGUpO1xuICAgIC8vIFJlc29sdmUgYXV0aERhdGEgZmlyc3QsXG4gICAgLy8gU28gd2UgZG9uJ3QgZW5kIHVwIHdpdGggbXVsdGlwbGUga2V5IHVwZGF0ZXNcbiAgICBmb3IgKGNvbnN0IGZpZWxkTmFtZSBpbiB1cGRhdGUpIHtcbiAgICAgIGNvbnN0IGF1dGhEYXRhTWF0Y2ggPSBmaWVsZE5hbWUubWF0Y2goL15fYXV0aF9kYXRhXyhbYS16QS1aMC05X10rKSQvKTtcbiAgICAgIGlmIChhdXRoRGF0YU1hdGNoKSB7XG4gICAgICAgIHZhciBwcm92aWRlciA9IGF1dGhEYXRhTWF0Y2hbMV07XG4gICAgICAgIGNvbnN0IHZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAgIGRlbGV0ZSB1cGRhdGVbZmllbGROYW1lXTtcbiAgICAgICAgdXBkYXRlWydhdXRoRGF0YSddID0gdXBkYXRlWydhdXRoRGF0YSddIHx8IHt9O1xuICAgICAgICB1cGRhdGVbJ2F1dGhEYXRhJ11bcHJvdmlkZXJdID0gdmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBmaWVsZE5hbWUgaW4gdXBkYXRlKSB7XG4gICAgICBjb25zdCBmaWVsZFZhbHVlID0gdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICAvLyBEcm9wIGFueSB1bmRlZmluZWQgdmFsdWVzLlxuICAgICAgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAndW5kZWZpbmVkJykge1xuICAgICAgICBkZWxldGUgdXBkYXRlW2ZpZWxkTmFtZV07XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUgPT09IG51bGwpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSBOVUxMYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkTmFtZSA9PSAnYXV0aERhdGEnKSB7XG4gICAgICAgIC8vIFRoaXMgcmVjdXJzaXZlbHkgc2V0cyB0aGUganNvbl9vYmplY3RcbiAgICAgICAgLy8gT25seSAxIGxldmVsIGRlZXBcbiAgICAgICAgY29uc3QgZ2VuZXJhdGUgPSAoanNvbmI6IHN0cmluZywga2V5OiBzdHJpbmcsIHZhbHVlOiBhbnkpID0+IHtcbiAgICAgICAgICByZXR1cm4gYGpzb25fb2JqZWN0X3NldF9rZXkoQ09BTEVTQ0UoJHtqc29uYn0sICd7fSc6Ompzb25iKSwgJHtrZXl9LCAke3ZhbHVlfSk6Ompzb25iYDtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3QgZ2VuZXJhdGVSZW1vdmUgPSAoanNvbmI6IHN0cmluZywga2V5OiBzdHJpbmcpID0+IHtcbiAgICAgICAgICByZXR1cm4gYChDT0FMRVNDRSgke2pzb25ifSwgJ3t9Jzo6anNvbmIpIC0gJHtrZXl9KWA7XG4gICAgICAgIH07XG4gICAgICAgIGNvbnN0IGxhc3RLZXkgPSBgJCR7aW5kZXh9Om5hbWVgO1xuICAgICAgICBjb25zdCBmaWVsZE5hbWVJbmRleCA9IGluZGV4O1xuICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUpO1xuICAgICAgICBjb25zdCB1cGRhdGUgPSBPYmplY3Qua2V5cyhmaWVsZFZhbHVlKS5yZWR1Y2UoKGxhc3RLZXk6IHN0cmluZywga2V5OiBzdHJpbmcpID0+IHtcbiAgICAgICAgICBsZXQgdmFsdWUgPSBmaWVsZFZhbHVlW2tleV07XG4gICAgICAgICAgaWYgKHZhbHVlICYmIHZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgICAgICB2YWx1ZSA9IG51bGw7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCkge1xuICAgICAgICAgICAgY29uc3Qgc3RyID0gZ2VuZXJhdGVSZW1vdmUobGFzdEtleSwgYCQke2luZGV4fTo6dGV4dGApO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goa2V5KTtcbiAgICAgICAgICAgIGluZGV4ICs9IDE7XG4gICAgICAgICAgICByZXR1cm4gc3RyO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBzdHIgPSBnZW5lcmF0ZShsYXN0S2V5LCBgJCR7aW5kZXh9Ojp0ZXh0YCwgYCQke2luZGV4ICsgMX06Ompzb25iYCk7XG4gICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgIHZhbHVlID0gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2YWx1ZXMucHVzaChrZXksIHZhbHVlKTtcbiAgICAgICAgICByZXR1cm4gc3RyO1xuICAgICAgICB9LCBsYXN0S2V5KTtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7ZmllbGROYW1lSW5kZXh9Om5hbWUgPSAke3VwZGF0ZX1gKTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnSW5jcmVtZW50Jykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9IENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAwKSArICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlLmFtb3VudCk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKGZpZWxkVmFsdWUuX19vcCA9PT0gJ0FkZCcpIHtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChcbiAgICAgICAgICBgJCR7aW5kZXh9Om5hbWUgPSBhcnJheV9hZGQoQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsICdbXSc6Ompzb25iKSwgJCR7aW5kZXggKyAxfTo6anNvbmIpYFxuICAgICAgICApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUub2JqZWN0cykpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdEZWxldGUnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIG51bGwpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fb3AgPT09ICdSZW1vdmUnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goXG4gICAgICAgICAgYCQke2luZGV4fTpuYW1lID0gYXJyYXlfcmVtb3ZlKENPQUxFU0NFKCQke2luZGV4fTpuYW1lLCAnW10nOjpqc29uYiksICQke2luZGV4ICsgMVxuICAgICAgICAgIH06Ompzb25iKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBKU09OLnN0cmluZ2lmeShmaWVsZFZhbHVlLm9iamVjdHMpKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX29wID09PSAnQWRkVW5pcXVlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKFxuICAgICAgICAgIGAkJHtpbmRleH06bmFtZSA9IGFycmF5X2FkZF91bmlxdWUoQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsICdbXSc6Ompzb25iKSwgJCR7aW5kZXggKyAxXG4gICAgICAgICAgfTo6anNvbmIpYFxuICAgICAgICApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIEpTT04uc3RyaW5naWZ5KGZpZWxkVmFsdWUub2JqZWN0cykpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZE5hbWUgPT09ICd1cGRhdGVkQXQnKSB7XG4gICAgICAgIC8vVE9ETzogc3RvcCBzcGVjaWFsIGNhc2luZyB0aGlzLiBJdCBzaG91bGQgY2hlY2sgZm9yIF9fdHlwZSA9PT0gJ0RhdGUnIGFuZCB1c2UgLmlzb1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGZpZWxkVmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmICh0eXBlb2YgZmllbGRWYWx1ZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1BvaW50ZXInKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUub2JqZWN0SWQpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ0RhdGUnKSB7XG4gICAgICAgIHVwZGF0ZVBhdHRlcm5zLnB1c2goYCQke2luZGV4fTpuYW1lID0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIHRvUG9zdGdyZXNWYWx1ZShmaWVsZFZhbHVlKSk7XG4gICAgICAgIGluZGV4ICs9IDI7XG4gICAgICB9IGVsc2UgaWYgKFV0aWxzLmlzRGF0ZShmaWVsZFZhbHVlKSkge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGRWYWx1ZS5fX3R5cGUgPT09ICdGaWxlJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCB0b1Bvc3RncmVzVmFsdWUoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ0dlb1BvaW50Jykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9IFBPSU5UKCQke2luZGV4ICsgMX0sICQke2luZGV4ICsgMn0pYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgZmllbGRWYWx1ZS5sb25naXR1ZGUsIGZpZWxkVmFsdWUubGF0aXR1ZGUpO1xuICAgICAgICBpbmRleCArPSAzO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gY29udmVydFBvbHlnb25Ub1NRTChmaWVsZFZhbHVlLmNvb3JkaW5hdGVzKTtcbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9Ojpwb2x5Z29uYCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgdmFsdWUpO1xuICAgICAgICBpbmRleCArPSAyO1xuICAgICAgfSBlbHNlIGlmIChmaWVsZFZhbHVlLl9fdHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICAvLyBub29wXG4gICAgICB9IGVsc2UgaWYgKHR5cGVvZiBmaWVsZFZhbHVlID09PSAnbnVtYmVyJykge1xuICAgICAgICB1cGRhdGVQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSA9ICQke2luZGV4ICsgMX1gKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCBmaWVsZFZhbHVlKTtcbiAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIHR5cGVvZiBmaWVsZFZhbHVlID09PSAnb2JqZWN0JyAmJlxuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0gJiZcbiAgICAgICAgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdPYmplY3QnXG4gICAgICApIHtcbiAgICAgICAgLy8gR2F0aGVyIGtleXMgdG8gaW5jcmVtZW50XG4gICAgICAgIGNvbnN0IGtleXNUb0luY3JlbWVudCA9IE9iamVjdC5rZXlzKG9yaWdpbmFsVXBkYXRlKVxuICAgICAgICAgIC5maWx0ZXIoayA9PiB7XG4gICAgICAgICAgICAvLyBjaG9vc2UgdG9wIGxldmVsIGZpZWxkcyB0aGF0IGhhdmUgYSBkZWxldGUgb3BlcmF0aW9uIHNldFxuICAgICAgICAgICAgLy8gTm90ZSB0aGF0IE9iamVjdC5rZXlzIGlzIGl0ZXJhdGluZyBvdmVyIHRoZSAqKm9yaWdpbmFsKiogdXBkYXRlIG9iamVjdFxuICAgICAgICAgICAgLy8gYW5kIHRoYXQgc29tZSBvZiB0aGUga2V5cyBvZiB0aGUgb3JpZ2luYWwgdXBkYXRlIGNvdWxkIGJlIG51bGwgb3IgdW5kZWZpbmVkOlxuICAgICAgICAgICAgLy8gKFNlZSB0aGUgYWJvdmUgY2hlY2sgYGlmIChmaWVsZFZhbHVlID09PSBudWxsIHx8IHR5cGVvZiBmaWVsZFZhbHVlID09IFwidW5kZWZpbmVkXCIpYClcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlID0gb3JpZ2luYWxVcGRhdGVba107XG4gICAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgICB2YWx1ZSAmJlxuICAgICAgICAgICAgICB2YWx1ZS5fX29wID09PSAnSW5jcmVtZW50JyAmJlxuICAgICAgICAgICAgICBrLnNwbGl0KCcuJykubGVuZ3RoID09PSAyICYmXG4gICAgICAgICAgICAgIGsuc3BsaXQoJy4nKVswXSA9PT0gZmllbGROYW1lXG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLm1hcChrID0+IGsuc3BsaXQoJy4nKVsxXSk7XG5cbiAgICAgICAgbGV0IGluY3JlbWVudFBhdHRlcm5zID0gJyc7XG4gICAgICAgIGNvbnN0IGluY3JlbWVudFZhbHVlcyA9IFtdO1xuICAgICAgICBpZiAoa2V5c1RvSW5jcmVtZW50Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBpbmNyZW1lbnRQYXR0ZXJucyA9XG4gICAgICAgICAgICAnIHx8ICcgK1xuICAgICAgICAgICAga2V5c1RvSW5jcmVtZW50XG4gICAgICAgICAgICAgIC5tYXAoYyA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgYW1vdW50ID0gZmllbGRWYWx1ZVtjXS5hbW91bnQ7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBhbW91bnQgIT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoUGFyc2UuRXJyb3IuSU5WQUxJRF9KU09OLCAnaW5jcmVtZW50aW5nIG11c3QgcHJvdmlkZSBhIG51bWJlcicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpbmNyZW1lbnRWYWx1ZXMucHVzaChhbW91bnQpO1xuICAgICAgICAgICAgICAgIGNvbnN0IGFtb3VudEluZGV4ID0gaW5kZXggKyBpbmNyZW1lbnRWYWx1ZXMubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGNvbnN0IGpzb25TYWZlTmFtZSA9IGVzY2FwZVNxbFN0cmluZyhlc2NhcGVKc29uU3RyaW5nKGMpKTtcbiAgICAgICAgICAgICAgICBjb25zdCBzcWxTYWZlTmFtZSA9IGVzY2FwZVNxbFN0cmluZyhjKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gYENPTkNBVCgne1wiJHtqc29uU2FmZU5hbWV9XCI6JywgQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUtPj4nJHtzcWxTYWZlTmFtZX0nLCcwJyk6OmludCArICQke2Ftb3VudEluZGV4fSwgJ30nKTo6anNvbmJgO1xuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAuam9pbignIHx8ICcpO1xuICAgICAgICAgIC8vIFN0cmlwIHRoZSBrZXlzXG4gICAgICAgICAga2V5c1RvSW5jcmVtZW50LmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgICAgIGRlbGV0ZSBmaWVsZFZhbHVlW2tleV07XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBrZXlzVG9EZWxldGU6IEFycmF5PHN0cmluZz4gPSBPYmplY3Qua2V5cyhvcmlnaW5hbFVwZGF0ZSlcbiAgICAgICAgICAuZmlsdGVyKGsgPT4ge1xuICAgICAgICAgICAgLy8gY2hvb3NlIHRvcCBsZXZlbCBmaWVsZHMgdGhhdCBoYXZlIGEgZGVsZXRlIG9wZXJhdGlvbiBzZXQuXG4gICAgICAgICAgICBjb25zdCB2YWx1ZSA9IG9yaWdpbmFsVXBkYXRlW2tdO1xuICAgICAgICAgICAgcmV0dXJuIChcbiAgICAgICAgICAgICAgdmFsdWUgJiZcbiAgICAgICAgICAgICAgdmFsdWUuX19vcCA9PT0gJ0RlbGV0ZScgJiZcbiAgICAgICAgICAgICAgay5zcGxpdCgnLicpLmxlbmd0aCA9PT0gMiAmJlxuICAgICAgICAgICAgICBrLnNwbGl0KCcuJylbMF0gPT09IGZpZWxkTmFtZVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5tYXAoayA9PiBrLnNwbGl0KCcuJylbMV0pO1xuXG4gICAgICAgIGNvbnN0IGRlbGV0ZVBhdHRlcm5zID0ga2V5c1RvRGVsZXRlLnJlZHVjZSgocDogc3RyaW5nLCBjOiBzdHJpbmcsIGk6IG51bWJlcikgPT4ge1xuICAgICAgICAgIHJldHVybiBwICsgYCAtICckJHtpbmRleCArIDEgKyBpbmNyZW1lbnRWYWx1ZXMubGVuZ3RoICsgaX06dmFsdWUnYDtcbiAgICAgICAgfSwgJycpO1xuICAgICAgICAvLyBPdmVycmlkZSBPYmplY3RcbiAgICAgICAgbGV0IHVwZGF0ZU9iamVjdCA9IFwiJ3t9Jzo6anNvbmJcIjtcblxuICAgICAgICBpZiAoZG90Tm90YXRpb25PcHRpb25zW2ZpZWxkTmFtZV0pIHtcbiAgICAgICAgICAvLyBNZXJnZSBPYmplY3RcbiAgICAgICAgICB1cGRhdGVPYmplY3QgPSBgQ09BTEVTQ0UoJCR7aW5kZXh9Om5hbWUsICd7fSc6Ompzb25iKWA7XG4gICAgICAgIH1cbiAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChcbiAgICAgICAgICBgJCR7aW5kZXh9Om5hbWUgPSAoJHt1cGRhdGVPYmplY3R9ICR7ZGVsZXRlUGF0dGVybnN9ICR7aW5jcmVtZW50UGF0dGVybnN9IHx8ICQke2luZGV4ICsgMSArIGluY3JlbWVudFZhbHVlcy5sZW5ndGggKyBrZXlzVG9EZWxldGUubGVuZ3RoXG4gICAgICAgICAgfTo6anNvbmIgKWBcbiAgICAgICAgKTtcbiAgICAgICAgdmFsdWVzLnB1c2goZmllbGROYW1lLCAuLi5pbmNyZW1lbnRWYWx1ZXMsIC4uLmtleXNUb0RlbGV0ZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSkpO1xuICAgICAgICBpbmRleCArPSAyICsgaW5jcmVtZW50VmFsdWVzLmxlbmd0aCArIGtleXNUb0RlbGV0ZS5sZW5ndGg7XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBBcnJheS5pc0FycmF5KGZpZWxkVmFsdWUpICYmXG4gICAgICAgIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJlxuICAgICAgICBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5J1xuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IGV4cGVjdGVkVHlwZSA9IHBhcnNlVHlwZVRvUG9zdGdyZXNUeXBlKHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSk7XG4gICAgICAgIGlmIChleHBlY3RlZFR5cGUgPT09ICd0ZXh0W10nKSB7XG4gICAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9Ojp0ZXh0W11gKTtcbiAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZE5hbWUsIGZpZWxkVmFsdWUpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdXBkYXRlUGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9Ojpqc29uYmApO1xuICAgICAgICAgIHZhbHVlcy5wdXNoKGZpZWxkTmFtZSwgSlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSkpO1xuICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRlYnVnKCdOb3Qgc3VwcG9ydGVkIHVwZGF0ZScsIHsgZmllbGROYW1lLCBmaWVsZFZhbHVlIH0pO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoXG4gICAgICAgICAgbmV3IFBhcnNlLkVycm9yKFxuICAgICAgICAgICAgUGFyc2UuRXJyb3IuT1BFUkFUSU9OX0ZPUkJJRERFTixcbiAgICAgICAgICAgIGBQb3N0Z3JlcyBkb2Vzbid0IHN1cHBvcnQgdXBkYXRlICR7SlNPTi5zdHJpbmdpZnkoZmllbGRWYWx1ZSl9IHlldGBcbiAgICAgICAgICApXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgd2hlcmUgPSBidWlsZFdoZXJlQ2xhdXNlKHtcbiAgICAgIHNjaGVtYSxcbiAgICAgIGluZGV4LFxuICAgICAgcXVlcnksXG4gICAgICBjYXNlSW5zZW5zaXRpdmU6IGZhbHNlLFxuICAgIH0pO1xuICAgIHZhbHVlcy5wdXNoKC4uLndoZXJlLnZhbHVlcyk7XG5cbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHdoZXJlLnBhdHRlcm4ubGVuZ3RoID4gMCA/IGBXSEVSRSAke3doZXJlLnBhdHRlcm59YCA6ICcnO1xuICAgIGNvbnN0IHFzID0gYFVQREFURSAkMTpuYW1lIFNFVCAke3VwZGF0ZVBhdHRlcm5zLmpvaW4oKX0gJHt3aGVyZUNsYXVzZX0gUkVUVVJOSU5HICpgO1xuICAgIGNvbnN0IHByb21pc2UgPSAodHJhbnNhY3Rpb25hbFNlc3Npb24gPyB0cmFuc2FjdGlvbmFsU2Vzc2lvbi50IDogdGhpcy5fY2xpZW50KVxuICAgICAgLmFueShxcywgdmFsdWVzKVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvcikge1xuICAgICAgICAgIGNvbnN0IGVyciA9IG5ldyBQYXJzZS5FcnJvcihcbiAgICAgICAgICAgIFBhcnNlLkVycm9yLkRVUExJQ0FURV9WQUxVRSxcbiAgICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICAgICk7XG4gICAgICAgICAgZXJyLnVuZGVybHlpbmdFcnJvciA9IGVycm9yO1xuICAgICAgICAgIGlmIChlcnJvci5jb25zdHJhaW50KSB7XG4gICAgICAgICAgICBjb25zdCBhdXRoRGF0YU1hdGNoID0gZXJyb3IuY29uc3RyYWludC5tYXRjaCgvX1VzZXJfdW5pcXVlX2F1dGhEYXRhXyhbYS16QS1aMC05X10rKV9pZC8pO1xuICAgICAgICAgICAgaWYgKGF1dGhEYXRhTWF0Y2gpIHtcbiAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBgX2F1dGhfZGF0YV8ke2F1dGhEYXRhTWF0Y2hbMV19YCB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY29uc3QgbWF0Y2hlcyA9IGVycm9yLmNvbnN0cmFpbnQubWF0Y2goL3VuaXF1ZV8oW2EtekEtWl0rKS8pO1xuICAgICAgICAgICAgICBpZiAobWF0Y2hlcyAmJiBBcnJheS5pc0FycmF5KG1hdGNoZXMpKSB7XG4gICAgICAgICAgICAgICAgZXJyLnVzZXJJbmZvID0geyBkdXBsaWNhdGVkX2ZpZWxkOiBtYXRjaGVzWzFdIH07XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9XG4gICAgICAgIHRocm93IGVycm9yO1xuICAgICAgfSk7XG4gICAgaWYgKHRyYW5zYWN0aW9uYWxTZXNzaW9uKSB7XG4gICAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5iYXRjaC5wdXNoKHByb21pc2UpO1xuICAgIH1cbiAgICByZXR1cm4gcHJvbWlzZTtcbiAgfVxuXG4gIC8vIEhvcGVmdWxseSwgd2UgY2FuIGdldCByaWQgb2YgdGhpcy4gSXQncyBvbmx5IHVzZWQgZm9yIGNvbmZpZyBhbmQgaG9va3MuXG4gIHVwc2VydE9uZU9iamVjdChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICB1cGRhdGU6IGFueSxcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbjogP2FueVxuICApIHtcbiAgICBkZWJ1ZygndXBzZXJ0T25lT2JqZWN0Jyk7XG4gICAgY29uc3QgY3JlYXRlVmFsdWUgPSBPYmplY3QuYXNzaWduKHt9LCBxdWVyeSwgdXBkYXRlKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVPYmplY3QoY2xhc3NOYW1lLCBzY2hlbWEsIGNyZWF0ZVZhbHVlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbikuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgLy8gaWdub3JlIGR1cGxpY2F0ZSB2YWx1ZSBlcnJvcnMgYXMgaXQncyB1cHNlcnRcbiAgICAgIGlmIChlcnJvci5jb2RlICE9PSBQYXJzZS5FcnJvci5EVVBMSUNBVEVfVkFMVUUpIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICByZXR1cm4gdGhpcy5maW5kT25lQW5kVXBkYXRlKGNsYXNzTmFtZSwgc2NoZW1hLCBxdWVyeSwgdXBkYXRlLCB0cmFuc2FjdGlvbmFsU2Vzc2lvbik7XG4gICAgfSk7XG4gIH1cblxuICBmaW5kKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIHNjaGVtYTogU2NoZW1hVHlwZSxcbiAgICBxdWVyeTogUXVlcnlUeXBlLFxuICAgIHsgc2tpcCwgbGltaXQsIHNvcnQsIGtleXMsIGNhc2VJbnNlbnNpdGl2ZSwgZXhwbGFpbiB9OiBRdWVyeU9wdGlvbnNcbiAgKSB7XG4gICAgZGVidWcoJ2ZpbmQnKTtcbiAgICBjb25zdCBoYXNMaW1pdCA9IGxpbWl0ICE9PSB1bmRlZmluZWQ7XG4gICAgY29uc3QgaGFzU2tpcCA9IHNraXAgIT09IHVuZGVmaW5lZDtcbiAgICBsZXQgdmFsdWVzID0gW2NsYXNzTmFtZV07XG4gICAgY29uc3Qgd2hlcmUgPSBidWlsZFdoZXJlQ2xhdXNlKHtcbiAgICAgIHNjaGVtYSxcbiAgICAgIHF1ZXJ5LFxuICAgICAgaW5kZXg6IDIsXG4gICAgICBjYXNlSW5zZW5zaXRpdmUsXG4gICAgfSk7XG4gICAgdmFsdWVzLnB1c2goLi4ud2hlcmUudmFsdWVzKTtcbiAgICBjb25zdCB3aGVyZVBhdHRlcm4gPSB3aGVyZS5wYXR0ZXJuLmxlbmd0aCA+IDAgPyBgV0hFUkUgJHt3aGVyZS5wYXR0ZXJufWAgOiAnJztcbiAgICBjb25zdCBsaW1pdFBhdHRlcm4gPSBoYXNMaW1pdCA/IGBMSU1JVCAkJHt2YWx1ZXMubGVuZ3RoICsgMX1gIDogJyc7XG4gICAgaWYgKGhhc0xpbWl0KSB7XG4gICAgICB2YWx1ZXMucHVzaChsaW1pdCk7XG4gICAgfVxuICAgIGNvbnN0IHNraXBQYXR0ZXJuID0gaGFzU2tpcCA/IGBPRkZTRVQgJCR7dmFsdWVzLmxlbmd0aCArIDF9YCA6ICcnO1xuICAgIGlmIChoYXNTa2lwKSB7XG4gICAgICB2YWx1ZXMucHVzaChza2lwKTtcbiAgICB9XG5cbiAgICBsZXQgc29ydFBhdHRlcm4gPSAnJztcbiAgICBpZiAoc29ydCkge1xuICAgICAgY29uc3Qgc29ydENvcHk6IGFueSA9IHNvcnQ7XG4gICAgICBjb25zdCBzb3J0aW5nID0gT2JqZWN0LmtleXMoc29ydClcbiAgICAgICAgLm1hcChrZXkgPT4ge1xuICAgICAgICAgIGNvbnN0IHRyYW5zZm9ybUtleSA9IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzKGtleSkuam9pbignLT4nKTtcbiAgICAgICAgICAvLyBVc2luZyAkaWR4IHBhdHRlcm4gZ2l2ZXM6ICBub24taW50ZWdlciBjb25zdGFudCBpbiBPUkRFUiBCWVxuICAgICAgICAgIGlmIChzb3J0Q29weVtrZXldID09PSAxKSB7XG4gICAgICAgICAgICByZXR1cm4gYCR7dHJhbnNmb3JtS2V5fSBBU0NgO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCR7dHJhbnNmb3JtS2V5fSBERVNDYDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oKTtcbiAgICAgIHNvcnRQYXR0ZXJuID0gc29ydCAhPT0gdW5kZWZpbmVkICYmIE9iamVjdC5rZXlzKHNvcnQpLmxlbmd0aCA+IDAgPyBgT1JERVIgQlkgJHtzb3J0aW5nfWAgOiAnJztcbiAgICB9XG4gICAgaWYgKHdoZXJlLnNvcnRzICYmIE9iamVjdC5rZXlzKCh3aGVyZS5zb3J0czogYW55KSkubGVuZ3RoID4gMCkge1xuICAgICAgc29ydFBhdHRlcm4gPSBgT1JERVIgQlkgJHt3aGVyZS5zb3J0cy5qb2luKCl9YDtcbiAgICB9XG5cbiAgICBsZXQgY29sdW1ucyA9ICcqJztcbiAgICBpZiAoa2V5cykge1xuICAgICAgLy8gRXhjbHVkZSBlbXB0eSBrZXlzXG4gICAgICAvLyBSZXBsYWNlIEFDTCBieSBpdCdzIGtleXNcbiAgICAgIGtleXMgPSBrZXlzLnJlZHVjZSgobWVtbywga2V5KSA9PiB7XG4gICAgICAgIGlmIChrZXkgPT09ICdBQ0wnKSB7XG4gICAgICAgICAgbWVtby5wdXNoKCdfcnBlcm0nKTtcbiAgICAgICAgICBtZW1vLnB1c2goJ193cGVybScpO1xuICAgICAgICB9IGVsc2UgaWYgKFxuICAgICAgICAgIGtleS5sZW5ndGggPiAwICYmXG4gICAgICAgICAgLy8gUmVtb3ZlIHNlbGVjdGVkIGZpZWxkIG5vdCByZWZlcmVuY2VkIGluIHRoZSBzY2hlbWFcbiAgICAgICAgICAvLyBSZWxhdGlvbiBpcyBub3QgYSBjb2x1bW4gaW4gcG9zdGdyZXNcbiAgICAgICAgICAvLyAkc2NvcmUgaXMgYSBQYXJzZSBzcGVjaWFsIGZpZWxkIGFuZCBpcyBhbHNvIG5vdCBhIGNvbHVtblxuICAgICAgICAgICgoc2NoZW1hLmZpZWxkc1trZXldICYmIHNjaGVtYS5maWVsZHNba2V5XS50eXBlICE9PSAnUmVsYXRpb24nKSB8fCBrZXkgPT09ICckc2NvcmUnKVxuICAgICAgICApIHtcbiAgICAgICAgICBtZW1vLnB1c2goa2V5KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbWVtbztcbiAgICAgIH0sIFtdKTtcbiAgICAgIGNvbHVtbnMgPSBrZXlzXG4gICAgICAgIC5tYXAoKGtleSwgaW5kZXgpID0+IHtcbiAgICAgICAgICBpZiAoa2V5ID09PSAnJHNjb3JlJykge1xuICAgICAgICAgICAgcmV0dXJuIGB0c19yYW5rX2NkKHRvX3RzdmVjdG9yKCQkezJ9LCAkJHszfTpuYW1lKSwgdG9fdHNxdWVyeSgkJHs0fSwgJCR7NX0pLCAzMikgYXMgc2NvcmVgO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gYCQke2luZGV4ICsgdmFsdWVzLmxlbmd0aCArIDF9Om5hbWVgO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbigpO1xuICAgICAgdmFsdWVzID0gdmFsdWVzLmNvbmNhdChrZXlzKTtcbiAgICB9XG5cbiAgICBjb25zdCBvcmlnaW5hbFF1ZXJ5ID0gYFNFTEVDVCAke2NvbHVtbnN9IEZST00gJDE6bmFtZSAke3doZXJlUGF0dGVybn0gJHtzb3J0UGF0dGVybn0gJHtsaW1pdFBhdHRlcm59ICR7c2tpcFBhdHRlcm59YDtcbiAgICBjb25zdCBxcyA9IGV4cGxhaW4gPyB0aGlzLmNyZWF0ZUV4cGxhaW5hYmxlUXVlcnkob3JpZ2luYWxRdWVyeSkgOiBvcmlnaW5hbFF1ZXJ5O1xuICAgIHJldHVybiB0aGlzLl9jbGllbnRcbiAgICAgIC5hbnkocXMsIHZhbHVlcylcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICBlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc1JlbGF0aW9uRG9lc05vdEV4aXN0RXJyb3IgJiZcbiAgICAgICAgICBlcnJvci5jb2RlICE9PSBQb3N0Z3Jlc01pc3NpbmdDb2x1bW5FcnJvclxuICAgICAgICApIHtcbiAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gW107XG4gICAgICB9KVxuICAgICAgLnRoZW4ocmVzdWx0cyA9PiB7XG4gICAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJlc3VsdHMubWFwKG9iamVjdCA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSk7XG4gICAgICB9KTtcbiAgfVxuXG4gIC8vIENvbnZlcnRzIGZyb20gYSBwb3N0Z3Jlcy1mb3JtYXQgb2JqZWN0IHRvIGEgUkVTVC1mb3JtYXQgb2JqZWN0LlxuICAvLyBEb2VzIG5vdCBzdHJpcCBvdXQgYW55dGhpbmcgYmFzZWQgb24gYSBsYWNrIG9mIGF1dGhlbnRpY2F0aW9uLlxuICBwb3N0Z3Jlc09iamVjdFRvUGFyc2VPYmplY3QoY2xhc3NOYW1lOiBzdHJpbmcsIG9iamVjdDogYW55LCBzY2hlbWE6IGFueSkge1xuICAgIE9iamVjdC5rZXlzKHNjaGVtYS5maWVsZHMpLmZvckVhY2goZmllbGROYW1lID0+IHtcbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInICYmIG9iamVjdFtmaWVsZE5hbWVdKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIG9iamVjdElkOiBvYmplY3RbZmllbGROYW1lXSxcbiAgICAgICAgICBfX3R5cGU6ICdQb2ludGVyJyxcbiAgICAgICAgICBjbGFzc05hbWU6IHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50YXJnZXRDbGFzcyxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1JlbGF0aW9uJykge1xuICAgICAgICBvYmplY3RbZmllbGROYW1lXSA9IHtcbiAgICAgICAgICBfX3R5cGU6ICdSZWxhdGlvbicsXG4gICAgICAgICAgY2xhc3NOYW1lOiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udGFyZ2V0Q2xhc3MsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBpZiAob2JqZWN0W2ZpZWxkTmFtZV0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnR5cGUgPT09ICdHZW9Qb2ludCcpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnR2VvUG9pbnQnLFxuICAgICAgICAgIGxhdGl0dWRlOiBvYmplY3RbZmllbGROYW1lXS55LFxuICAgICAgICAgIGxvbmdpdHVkZTogb2JqZWN0W2ZpZWxkTmFtZV0ueCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGlmIChvYmplY3RbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvbHlnb24nKSB7XG4gICAgICAgIGxldCBjb29yZHMgPSBuZXcgU3RyaW5nKG9iamVjdFtmaWVsZE5hbWVdKTtcbiAgICAgICAgY29vcmRzID0gY29vcmRzLnN1YnN0cmluZygyLCBjb29yZHMubGVuZ3RoIC0gMikuc3BsaXQoJyksKCcpO1xuICAgICAgICBjb25zdCB1cGRhdGVkQ29vcmRzID0gY29vcmRzLm1hcChwb2ludCA9PiB7XG4gICAgICAgICAgcmV0dXJuIFtwYXJzZUZsb2F0KHBvaW50LnNwbGl0KCcsJylbMV0pLCBwYXJzZUZsb2F0KHBvaW50LnNwbGl0KCcsJylbMF0pXTtcbiAgICAgICAgfSk7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ1BvbHlnb24nLFxuICAgICAgICAgIGNvb3JkaW5hdGVzOiB1cGRhdGVkQ29vcmRzLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlID09PSAnRmlsZScpIHtcbiAgICAgICAgb2JqZWN0W2ZpZWxkTmFtZV0gPSB7XG4gICAgICAgICAgX190eXBlOiAnRmlsZScsXG4gICAgICAgICAgbmFtZTogb2JqZWN0W2ZpZWxkTmFtZV0sXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSk7XG4gICAgLy9UT0RPOiByZW1vdmUgdGhpcyByZWxpYW5jZSBvbiB0aGUgbW9uZ28gZm9ybWF0LiBEQiBhZGFwdGVyIHNob3VsZG4ndCBrbm93IHRoZXJlIGlzIGEgZGlmZmVyZW5jZSBiZXR3ZWVuIGNyZWF0ZWQgYXQgYW5kIGFueSBvdGhlciBkYXRlIGZpZWxkLlxuICAgIGlmIChvYmplY3QuY3JlYXRlZEF0KSB7XG4gICAgICBvYmplY3QuY3JlYXRlZEF0ID0gb2JqZWN0LmNyZWF0ZWRBdC50b0lTT1N0cmluZygpO1xuICAgIH1cbiAgICBpZiAob2JqZWN0LnVwZGF0ZWRBdCkge1xuICAgICAgb2JqZWN0LnVwZGF0ZWRBdCA9IG9iamVjdC51cGRhdGVkQXQudG9JU09TdHJpbmcoKTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5leHBpcmVzQXQpIHtcbiAgICAgIG9iamVjdC5leHBpcmVzQXQgPSB7XG4gICAgICAgIF9fdHlwZTogJ0RhdGUnLFxuICAgICAgICBpc286IG9iamVjdC5leHBpcmVzQXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0ID0ge1xuICAgICAgICBfX3R5cGU6ICdEYXRlJyxcbiAgICAgICAgaXNvOiBvYmplY3QuX2VtYWlsX3ZlcmlmeV90b2tlbl9leHBpcmVzX2F0LnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgIH1cbiAgICBpZiAob2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCkge1xuICAgICAgb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9hY2NvdW50X2xvY2tvdXRfZXhwaXJlc19hdC50b0lTT1N0cmluZygpLFxuICAgICAgfTtcbiAgICB9XG4gICAgaWYgKG9iamVjdC5fcGVyaXNoYWJsZV90b2tlbl9leHBpcmVzX2F0KSB7XG4gICAgICBvYmplY3QuX3BlcmlzaGFibGVfdG9rZW5fZXhwaXJlc19hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9wZXJpc2hhYmxlX3Rva2VuX2V4cGlyZXNfYXQudG9JU09TdHJpbmcoKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGlmIChvYmplY3QuX3Bhc3N3b3JkX2NoYW5nZWRfYXQpIHtcbiAgICAgIG9iamVjdC5fcGFzc3dvcmRfY2hhbmdlZF9hdCA9IHtcbiAgICAgICAgX190eXBlOiAnRGF0ZScsXG4gICAgICAgIGlzbzogb2JqZWN0Ll9wYXNzd29yZF9jaGFuZ2VkX2F0LnRvSVNPU3RyaW5nKCksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgZmllbGROYW1lIGluIG9iamVjdCkge1xuICAgICAgaWYgKG9iamVjdFtmaWVsZE5hbWVdID09PSBudWxsKSB7XG4gICAgICAgIGRlbGV0ZSBvYmplY3RbZmllbGROYW1lXTtcbiAgICAgIH1cbiAgICAgIGlmIChVdGlscy5pc0RhdGUob2JqZWN0W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgIG9iamVjdFtmaWVsZE5hbWVdID0ge1xuICAgICAgICAgIF9fdHlwZTogJ0RhdGUnLFxuICAgICAgICAgIGlzbzogb2JqZWN0W2ZpZWxkTmFtZV0udG9JU09TdHJpbmcoKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gb2JqZWN0O1xuICB9XG5cbiAgLy8gQ3JlYXRlIGEgdW5pcXVlIGluZGV4LiBVbmlxdWUgaW5kZXhlcyBvbiBudWxsYWJsZSBmaWVsZHMgYXJlIG5vdCBhbGxvd2VkLiBTaW5jZSB3ZSBkb24ndFxuICAvLyBjdXJyZW50bHkga25vdyB3aGljaCBmaWVsZHMgYXJlIG51bGxhYmxlIGFuZCB3aGljaCBhcmVuJ3QsIHdlIGlnbm9yZSB0aGF0IGNyaXRlcmlhLlxuICAvLyBBcyBzdWNoLCB3ZSBzaG91bGRuJ3QgZXhwb3NlIHRoaXMgZnVuY3Rpb24gdG8gdXNlcnMgb2YgcGFyc2UgdW50aWwgd2UgaGF2ZSBhbiBvdXQtb2YtYmFuZFxuICAvLyBXYXkgb2YgZGV0ZXJtaW5pbmcgaWYgYSBmaWVsZCBpcyBudWxsYWJsZS4gVW5kZWZpbmVkIGRvZXNuJ3QgY291bnQgYWdhaW5zdCB1bmlxdWVuZXNzLFxuICAvLyB3aGljaCBpcyB3aHkgd2UgdXNlIHNwYXJzZSBpbmRleGVzLlxuICBhc3luYyBlbnN1cmVVbmlxdWVuZXNzKGNsYXNzTmFtZTogc3RyaW5nLCBzY2hlbWE6IFNjaGVtYVR5cGUsIGZpZWxkTmFtZXM6IHN0cmluZ1tdKSB7XG4gICAgY29uc3QgY29uc3RyYWludE5hbWUgPSBgJHtjbGFzc05hbWV9X3VuaXF1ZV8ke2ZpZWxkTmFtZXMuc29ydCgpLmpvaW4oJ18nKX1gO1xuICAgIGNvbnN0IGNvbnN0cmFpbnRQYXR0ZXJucyA9IGZpZWxkTmFtZXMubWFwKChmaWVsZE5hbWUsIGluZGV4KSA9PiBgJCR7aW5kZXggKyAzfTpuYW1lYCk7XG4gICAgY29uc3QgcXMgPSBgQ1JFQVRFIFVOSVFVRSBJTkRFWCBJRiBOT1QgRVhJU1RTICQyOm5hbWUgT04gJDE6bmFtZSgke2NvbnN0cmFpbnRQYXR0ZXJucy5qb2luKCl9KWA7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5ub25lKHFzLCBbY2xhc3NOYW1lLCBjb25zdHJhaW50TmFtZSwgLi4uZmllbGROYW1lc10pLmNhdGNoKGVycm9yID0+IHtcbiAgICAgIGlmIChlcnJvci5jb2RlID09PSBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgJiYgZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhjb25zdHJhaW50TmFtZSkpIHtcbiAgICAgICAgLy8gSW5kZXggYWxyZWFkeSBleGlzdHMuIElnbm9yZSBlcnJvci5cbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciAmJlxuICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGNvbnN0cmFpbnROYW1lKVxuICAgICAgKSB7XG4gICAgICAgIC8vIENhc3QgdGhlIGVycm9yIGludG8gdGhlIHByb3BlciBwYXJzZSBlcnJvclxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBDcmVhdGVzIGEgdW5pcXVlIGluZGV4IG9uIGF1dGhEYXRhLT48cHJvdmlkZXI+LT4+J2lkJyB0byBwcmV2ZW50XG4gIC8vIHJhY2UgY29uZGl0aW9ucyBkdXJpbmcgY29uY3VycmVudCBzaWdudXBzIHdpdGggdGhlIHNhbWUgYXV0aERhdGEuXG4gIGFzeW5jIGVuc3VyZUF1dGhEYXRhVW5pcXVlbmVzcyhwcm92aWRlcjogc3RyaW5nKSB7XG4gICAgY29uc3QgaW5kZXhOYW1lID0gYF9Vc2VyX3VuaXF1ZV9hdXRoRGF0YV8ke3Byb3ZpZGVyfV9pZGA7XG4gICAgY29uc3QgcXMgPSBgQ1JFQVRFIFVOSVFVRSBJTkRFWCBJRiBOT1QgRVhJU1RTICQxOm5hbWUgT04gXCJfVXNlclwiICgoXCJhdXRoRGF0YVwiLT4kMjo6dGV4dC0+PidpZCcpKSBXSEVSRSBcImF1dGhEYXRhXCItPiQyOjp0ZXh0LT4+J2lkJyBJUyBOT1QgTlVMTGA7XG4gICAgYXdhaXQgdGhpcy5fY2xpZW50Lm5vbmUocXMsIFtpbmRleE5hbWUsIHByb3ZpZGVyXSkuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgaWYgKFxuICAgICAgICBlcnJvci5jb2RlID09PSBQb3N0Z3Jlc0R1cGxpY2F0ZVJlbGF0aW9uRXJyb3IgJiZcbiAgICAgICAgZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhpbmRleE5hbWUpXG4gICAgICApIHtcbiAgICAgICAgLy8gSW5kZXggYWxyZWFkeSBleGlzdHMuIElnbm9yZSBlcnJvci5cbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIGVycm9yLmNvZGUgPT09IFBvc3RncmVzVW5pcXVlSW5kZXhWaW9sYXRpb25FcnJvciAmJlxuICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGluZGV4TmFtZSlcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICdUcmllZCB0byBlbnN1cmUgZmllbGQgdW5pcXVlbmVzcyBmb3IgYSBjbGFzcyB0aGF0IGFscmVhZHkgaGFzIGR1cGxpY2F0ZXMuJ1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBFeGVjdXRlcyBhIGNvdW50LlxuICBhc3luYyBjb3VudChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgcXVlcnk6IFF1ZXJ5VHlwZSxcbiAgICByZWFkUHJlZmVyZW5jZT86IHN0cmluZyxcbiAgICBlc3RpbWF0ZT86IGJvb2xlYW4gPSB0cnVlXG4gICkge1xuICAgIGRlYnVnKCdjb3VudCcpO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtjbGFzc05hbWVdO1xuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7XG4gICAgICBzY2hlbWEsXG4gICAgICBxdWVyeSxcbiAgICAgIGluZGV4OiAyLFxuICAgICAgY2FzZUluc2Vuc2l0aXZlOiBmYWxzZSxcbiAgICB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID0gd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgbGV0IHFzID0gJyc7XG5cbiAgICBpZiAod2hlcmUucGF0dGVybi5sZW5ndGggPiAwIHx8ICFlc3RpbWF0ZSkge1xuICAgICAgcXMgPSBgU0VMRUNUIGNvdW50KCopIEZST00gJDE6bmFtZSAke3doZXJlUGF0dGVybn1gO1xuICAgIH0gZWxzZSB7XG4gICAgICBxcyA9ICdTRUxFQ1QgcmVsdHVwbGVzIEFTIGFwcHJveGltYXRlX3Jvd19jb3VudCBGUk9NIHBnX2NsYXNzIFdIRVJFIHJlbG5hbWUgPSAkMSc7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudFxuICAgICAgLm9uZShxcywgdmFsdWVzLCBhID0+IHtcbiAgICAgICAgaWYgKGEuYXBwcm94aW1hdGVfcm93X2NvdW50ID09IG51bGwgfHwgYS5hcHByb3hpbWF0ZV9yb3dfY291bnQgPT0gLTEpIHtcbiAgICAgICAgICByZXR1cm4gIWlzTmFOKCthLmNvdW50KSA/ICthLmNvdW50IDogMDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gK2EuYXBwcm94aW1hdGVfcm93X2NvdW50O1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIGVycm9yLmNvZGUgIT09IFBvc3RncmVzUmVsYXRpb25Eb2VzTm90RXhpc3RFcnJvciAmJlxuICAgICAgICAgIGVycm9yLmNvZGUgIT09IFBvc3RncmVzTWlzc2luZ0NvbHVtbkVycm9yXG4gICAgICAgICkge1xuICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiAwO1xuICAgICAgfSk7XG4gIH1cblxuICBhc3luYyBkaXN0aW5jdChjbGFzc05hbWU6IHN0cmluZywgc2NoZW1hOiBTY2hlbWFUeXBlLCBxdWVyeTogUXVlcnlUeXBlLCBmaWVsZE5hbWU6IHN0cmluZykge1xuICAgIGRlYnVnKCdkaXN0aW5jdCcpO1xuICAgIGNvbnN0IGZpZWxkU2VnbWVudHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgZmllbGRTZWdtZW50cykge1xuICAgICAgaWYgKCFzZWdtZW50Lm1hdGNoKC9eW2EtekEtWl1bYS16QS1aMC05X10qJC8pKSB7XG4gICAgICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0tFWV9OQU1FLCBgSW52YWxpZCBmaWVsZCBuYW1lOiAke2ZpZWxkTmFtZX1gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgbGV0IGZpZWxkID0gZmllbGROYW1lO1xuICAgIGxldCBjb2x1bW4gPSBmaWVsZE5hbWU7XG4gICAgY29uc3QgaXNOZXN0ZWQgPSBmaWVsZE5hbWUuaW5kZXhPZignLicpID49IDA7XG4gICAgaWYgKGlzTmVzdGVkKSB7XG4gICAgICBmaWVsZCA9IHRyYW5zZm9ybURvdEZpZWxkVG9Db21wb25lbnRzKGZpZWxkTmFtZSkuam9pbignLT4nKTtcbiAgICAgIGNvbHVtbiA9IGZpZWxkU2VnbWVudHNbMF07XG4gICAgfVxuICAgIGNvbnN0IGlzQXJyYXlGaWVsZCA9XG4gICAgICBzY2hlbWEuZmllbGRzICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ0FycmF5JztcbiAgICBjb25zdCBpc1BvaW50ZXJGaWVsZCA9XG4gICAgICBzY2hlbWEuZmllbGRzICYmIHNjaGVtYS5maWVsZHNbZmllbGROYW1lXSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0udHlwZSA9PT0gJ1BvaW50ZXInO1xuICAgIGNvbnN0IHZhbHVlcyA9IFtmaWVsZCwgY29sdW1uLCBjbGFzc05hbWVdO1xuICAgIGNvbnN0IHdoZXJlID0gYnVpbGRXaGVyZUNsYXVzZSh7XG4gICAgICBzY2hlbWEsXG4gICAgICBxdWVyeSxcbiAgICAgIGluZGV4OiA0LFxuICAgICAgY2FzZUluc2Vuc2l0aXZlOiBmYWxzZSxcbiAgICB9KTtcbiAgICB2YWx1ZXMucHVzaCguLi53aGVyZS52YWx1ZXMpO1xuXG4gICAgY29uc3Qgd2hlcmVQYXR0ZXJuID0gd2hlcmUucGF0dGVybi5sZW5ndGggPiAwID8gYFdIRVJFICR7d2hlcmUucGF0dGVybn1gIDogJyc7XG4gICAgY29uc3QgdHJhbnNmb3JtZXIgPSBpc0FycmF5RmllbGQgPyAnanNvbmJfYXJyYXlfZWxlbWVudHMnIDogJ09OJztcbiAgICBsZXQgcXMgPSBgU0VMRUNUIERJU1RJTkNUICR7dHJhbnNmb3JtZXJ9KCQxOm5hbWUpICQyOm5hbWUgRlJPTSAkMzpuYW1lICR7d2hlcmVQYXR0ZXJufWA7XG4gICAgaWYgKGlzTmVzdGVkKSB7XG4gICAgICBxcyA9IGBTRUxFQ1QgRElTVElOQ1QgJHt0cmFuc2Zvcm1lcn0oJDE6cmF3KSAkMjpyYXcgRlJPTSAkMzpuYW1lICR7d2hlcmVQYXR0ZXJufWA7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9jbGllbnRcbiAgICAgIC5hbnkocXMsIHZhbHVlcylcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIGlmIChlcnJvci5jb2RlID09PSBQb3N0Z3Jlc01pc3NpbmdDb2x1bW5FcnJvcikge1xuICAgICAgICAgIHJldHVybiBbXTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH0pXG4gICAgICAudGhlbihyZXN1bHRzID0+IHtcbiAgICAgICAgaWYgKCFpc05lc3RlZCkge1xuICAgICAgICAgIHJlc3VsdHMgPSByZXN1bHRzLmZpbHRlcihvYmplY3QgPT4gb2JqZWN0W2ZpZWxkXSAhPT0gbnVsbCk7XG4gICAgICAgICAgcmV0dXJuIHJlc3VsdHMubWFwKG9iamVjdCA9PiB7XG4gICAgICAgICAgICBpZiAoIWlzUG9pbnRlckZpZWxkKSB7XG4gICAgICAgICAgICAgIHJldHVybiBvYmplY3RbZmllbGRdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgX190eXBlOiAnUG9pbnRlcicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogc2NoZW1hLmZpZWxkc1tmaWVsZE5hbWVdLnRhcmdldENsYXNzLFxuICAgICAgICAgICAgICBvYmplY3RJZDogb2JqZWN0W2ZpZWxkXSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgY2hpbGQgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKVsxXTtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHMubWFwKG9iamVjdCA9PiBvYmplY3RbY29sdW1uXVtjaGlsZF0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKHJlc3VsdHMgPT5cbiAgICAgICAgcmVzdWx0cy5tYXAob2JqZWN0ID0+IHRoaXMucG9zdGdyZXNPYmplY3RUb1BhcnNlT2JqZWN0KGNsYXNzTmFtZSwgb2JqZWN0LCBzY2hlbWEpKVxuICAgICAgKTtcbiAgfVxuXG4gIGFzeW5jIGFnZ3JlZ2F0ZShcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IGFueSxcbiAgICBwaXBlbGluZTogYW55LFxuICAgIHJlYWRQcmVmZXJlbmNlOiA/c3RyaW5nLFxuICAgIGhpbnQ6ID9taXhlZCxcbiAgICBleHBsYWluPzogYm9vbGVhblxuICApIHtcbiAgICBkZWJ1ZygnYWdncmVnYXRlJyk7XG4gICAgY29uc3QgdmFsdWVzID0gW2NsYXNzTmFtZV07XG4gICAgbGV0IGluZGV4OiBudW1iZXIgPSAyO1xuICAgIGxldCBjb2x1bW5zOiBzdHJpbmdbXSA9IFtdO1xuICAgIGxldCBjb3VudEZpZWxkID0gbnVsbDtcbiAgICBsZXQgZ3JvdXBWYWx1ZXMgPSBudWxsO1xuICAgIGxldCB3aGVyZVBhdHRlcm4gPSAnJztcbiAgICBsZXQgbGltaXRQYXR0ZXJuID0gJyc7XG4gICAgbGV0IHNraXBQYXR0ZXJuID0gJyc7XG4gICAgbGV0IHNvcnRQYXR0ZXJuID0gJyc7XG4gICAgbGV0IGdyb3VwUGF0dGVybiA9ICcnO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcGlwZWxpbmUubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgIGNvbnN0IHN0YWdlID0gcGlwZWxpbmVbaV07XG4gICAgICBpZiAoc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgIGZvciAoY29uc3QgZmllbGQgaW4gc3RhZ2UuJGdyb3VwKSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBzdGFnZS4kZ3JvdXBbZmllbGRdO1xuICAgICAgICAgIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZpZWxkID09PSAnX2lkJyAmJiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnICYmIHZhbHVlICE9PSAnJykge1xuICAgICAgICAgICAgY29sdW1ucy5wdXNoKGAkJHtpbmRleH06bmFtZSBBUyBcIm9iamVjdElkXCJgKTtcbiAgICAgICAgICAgIGdyb3VwUGF0dGVybiA9IGBHUk9VUCBCWSAkJHtpbmRleH06bmFtZWA7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZSkpO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZmllbGQgPT09ICdfaWQnICYmIHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aCAhPT0gMCkge1xuICAgICAgICAgICAgZ3JvdXBWYWx1ZXMgPSB2YWx1ZTtcbiAgICAgICAgICAgIGNvbnN0IGdyb3VwQnlGaWVsZHMgPSBbXTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgYWxpYXMgaW4gdmFsdWUpIHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZVthbGlhc10gPT09ICdzdHJpbmcnICYmIHZhbHVlW2FsaWFzXSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IHRyYW5zZm9ybUFnZ3JlZ2F0ZUZpZWxkKHZhbHVlW2FsaWFzXSk7XG4gICAgICAgICAgICAgICAgaWYgKCFncm91cEJ5RmllbGRzLmluY2x1ZGVzKGBcIiR7c291cmNlfVwiYCkpIHtcbiAgICAgICAgICAgICAgICAgIGdyb3VwQnlGaWVsZHMucHVzaChgXCIke3NvdXJjZX1cImApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaChzb3VyY2UsIGFsaWFzKTtcbiAgICAgICAgICAgICAgICBjb2x1bW5zLnB1c2goYCQke2luZGV4fTpuYW1lIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgb3BlcmF0aW9uID0gT2JqZWN0LmtleXModmFsdWVbYWxpYXNdKVswXTtcbiAgICAgICAgICAgICAgICBjb25zdCBzb3VyY2UgPSB0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZVthbGlhc11bb3BlcmF0aW9uXSk7XG4gICAgICAgICAgICAgICAgaWYgKG1vbmdvQWdncmVnYXRlVG9Qb3N0Z3Jlc1tvcGVyYXRpb25dKSB7XG4gICAgICAgICAgICAgICAgICBpZiAoIWdyb3VwQnlGaWVsZHMuaW5jbHVkZXMoYFwiJHtzb3VyY2V9XCJgKSkge1xuICAgICAgICAgICAgICAgICAgICBncm91cEJ5RmllbGRzLnB1c2goYFwiJHtzb3VyY2V9XCJgKTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgIGNvbHVtbnMucHVzaChcbiAgICAgICAgICAgICAgICAgICAgYEVYVFJBQ1QoJHttb25nb0FnZ3JlZ2F0ZVRvUG9zdGdyZXNbb3BlcmF0aW9uXVxuICAgICAgICAgICAgICAgICAgICB9IEZST00gJCR7aW5kZXh9Om5hbWUgQVQgVElNRSBaT05FICdVVEMnKTo6aW50ZWdlciBBUyAkJHtpbmRleCArIDF9Om5hbWVgXG4gICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgdmFsdWVzLnB1c2goc291cmNlLCBhbGlhcyk7XG4gICAgICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZ3JvdXBQYXR0ZXJuID0gYEdST1VQIEJZICQke2luZGV4fTpyYXdgO1xuICAgICAgICAgICAgdmFsdWVzLnB1c2goZ3JvdXBCeUZpZWxkcy5qb2luKCkpO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgaWYgKHZhbHVlLiRzdW0pIHtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZS4kc3VtID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgU1VNKCQke2luZGV4fTpuYW1lKSBBUyAkJHtpbmRleCArIDF9Om5hbWVgKTtcbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kc3VtKSwgZmllbGQpO1xuICAgICAgICAgICAgICAgIGluZGV4ICs9IDI7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRGaWVsZCA9IGZpZWxkO1xuICAgICAgICAgICAgICAgIGNvbHVtbnMucHVzaChgQ09VTlQoKikgQVMgJCR7aW5kZXh9Om5hbWVgKTtcbiAgICAgICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCk7XG4gICAgICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZhbHVlLiRtYXgpIHtcbiAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBNQVgoJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kbWF4KSwgZmllbGQpO1xuICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZhbHVlLiRtaW4pIHtcbiAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBNSU4oJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kbWluKSwgZmllbGQpO1xuICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHZhbHVlLiRhdmcpIHtcbiAgICAgICAgICAgICAgY29sdW1ucy5wdXNoKGBBVkcoJCR7aW5kZXh9Om5hbWUpIEFTICQke2luZGV4ICsgMX06bmFtZWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaCh0cmFuc2Zvcm1BZ2dyZWdhdGVGaWVsZCh2YWx1ZS4kYXZnKSwgZmllbGQpO1xuICAgICAgICAgICAgICBpbmRleCArPSAyO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29sdW1ucy5wdXNoKCcqJyk7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHByb2plY3QpIHtcbiAgICAgICAgaWYgKGNvbHVtbnMuaW5jbHVkZXMoJyonKSkge1xuICAgICAgICAgIGNvbHVtbnMgPSBbXTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIGluIHN0YWdlLiRwcm9qZWN0KSB7XG4gICAgICAgICAgY29uc3QgdmFsdWUgPSBzdGFnZS4kcHJvamVjdFtmaWVsZF07XG4gICAgICAgICAgaWYgKHZhbHVlID09PSAxIHx8IHZhbHVlID09PSB0cnVlKSB7XG4gICAgICAgICAgICBjb2x1bW5zLnB1c2goYCQke2luZGV4fTpuYW1lYCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCk7XG4gICAgICAgICAgICBpbmRleCArPSAxO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKHN0YWdlLiRtYXRjaCkge1xuICAgICAgICBjb25zdCBwYXR0ZXJucyA9IFtdO1xuICAgICAgICBjb25zdCBvck9yQW5kID0gT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHN0YWdlLiRtYXRjaCwgJyRvcicpXG4gICAgICAgICAgPyAnIE9SICdcbiAgICAgICAgICA6ICcgQU5EICc7XG5cbiAgICAgICAgaWYgKHN0YWdlLiRtYXRjaC4kb3IpIHtcbiAgICAgICAgICBjb25zdCBjb2xsYXBzZSA9IHt9O1xuICAgICAgICAgIHN0YWdlLiRtYXRjaC4kb3IuZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgICAgIGZvciAoY29uc3Qga2V5IGluIGVsZW1lbnQpIHtcbiAgICAgICAgICAgICAgY29sbGFwc2Vba2V5XSA9IGVsZW1lbnRba2V5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBzdGFnZS4kbWF0Y2ggPSBjb2xsYXBzZTtcbiAgICAgICAgfVxuICAgICAgICBmb3IgKGxldCBmaWVsZCBpbiBzdGFnZS4kbWF0Y2gpIHtcbiAgICAgICAgICBjb25zdCB2YWx1ZSA9IHN0YWdlLiRtYXRjaFtmaWVsZF07XG4gICAgICAgICAgaWYgKGZpZWxkID09PSAnX2lkJykge1xuICAgICAgICAgICAgZmllbGQgPSAnb2JqZWN0SWQnO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBtYXRjaFBhdHRlcm5zID0gW107XG4gICAgICAgICAgT2JqZWN0LmtleXMoUGFyc2VUb1Bvc2dyZXNDb21wYXJhdG9yKS5mb3JFYWNoKGNtcCA9PiB7XG4gICAgICAgICAgICBpZiAodmFsdWVbY21wXSkge1xuICAgICAgICAgICAgICBjb25zdCBwZ0NvbXBhcmF0b3IgPSBQYXJzZVRvUG9zZ3Jlc0NvbXBhcmF0b3JbY21wXTtcbiAgICAgICAgICAgICAgbWF0Y2hQYXR0ZXJucy5wdXNoKGAkJHtpbmRleH06bmFtZSAke3BnQ29tcGFyYXRvcn0gJCR7aW5kZXggKyAxfWApO1xuICAgICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCwgdG9Qb3N0Z3Jlc1ZhbHVlKHZhbHVlW2NtcF0pKTtcbiAgICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBpZiAobWF0Y2hQYXR0ZXJucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBwYXR0ZXJucy5wdXNoKGAoJHttYXRjaFBhdHRlcm5zLmpvaW4oJyBBTkQgJyl9KWApO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc2NoZW1hLmZpZWxkc1tmaWVsZF0gJiYgc2NoZW1hLmZpZWxkc1tmaWVsZF0udHlwZSAmJiBtYXRjaFBhdHRlcm5zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgcGF0dGVybnMucHVzaChgJCR7aW5kZXh9Om5hbWUgPSAkJHtpbmRleCArIDF9YCk7XG4gICAgICAgICAgICB2YWx1ZXMucHVzaChmaWVsZCwgdmFsdWUpO1xuICAgICAgICAgICAgaW5kZXggKz0gMjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgd2hlcmVQYXR0ZXJuID0gcGF0dGVybnMubGVuZ3RoID4gMCA/IGBXSEVSRSAke3BhdHRlcm5zLmpvaW4oYCAke29yT3JBbmR9IGApfWAgOiAnJztcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kbGltaXQpIHtcbiAgICAgICAgbGltaXRQYXR0ZXJuID0gYExJTUlUICQke2luZGV4fWA7XG4gICAgICAgIHZhbHVlcy5wdXNoKHN0YWdlLiRsaW1pdCk7XG4gICAgICAgIGluZGV4ICs9IDE7XG4gICAgICB9XG4gICAgICBpZiAoc3RhZ2UuJHNraXApIHtcbiAgICAgICAgc2tpcFBhdHRlcm4gPSBgT0ZGU0VUICQke2luZGV4fWA7XG4gICAgICAgIHZhbHVlcy5wdXNoKHN0YWdlLiRza2lwKTtcbiAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgIH1cbiAgICAgIGlmIChzdGFnZS4kc29ydCkge1xuICAgICAgICBjb25zdCBzb3J0ID0gc3RhZ2UuJHNvcnQ7XG4gICAgICAgIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhzb3J0KTtcbiAgICAgICAgY29uc3Qgc29ydGluZyA9IGtleXNcbiAgICAgICAgICAubWFwKGtleSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0cmFuc2Zvcm1lciA9IHNvcnRba2V5XSA9PT0gMSA/ICdBU0MnIDogJ0RFU0MnO1xuICAgICAgICAgICAgY29uc3Qgb3JkZXIgPSBgJCR7aW5kZXh9Om5hbWUgJHt0cmFuc2Zvcm1lcn1gO1xuICAgICAgICAgICAgaW5kZXggKz0gMTtcbiAgICAgICAgICAgIHJldHVybiBvcmRlcjtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5qb2luKCk7XG4gICAgICAgIHZhbHVlcy5wdXNoKC4uLmtleXMpO1xuICAgICAgICBzb3J0UGF0dGVybiA9IHNvcnQgIT09IHVuZGVmaW5lZCAmJiBzb3J0aW5nLmxlbmd0aCA+IDAgPyBgT1JERVIgQlkgJHtzb3J0aW5nfWAgOiAnJztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZ3JvdXBQYXR0ZXJuKSB7XG4gICAgICBjb2x1bW5zLmZvckVhY2goKGUsIGksIGEpID0+IHtcbiAgICAgICAgaWYgKGUgJiYgZS50cmltKCkgPT09ICcqJykge1xuICAgICAgICAgIGFbaV0gPSAnJztcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JpZ2luYWxRdWVyeSA9IGBTRUxFQ1QgJHtjb2x1bW5zXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAuam9pbigpfSBGUk9NICQxOm5hbWUgJHt3aGVyZVBhdHRlcm59ICR7c2tpcFBhdHRlcm59ICR7Z3JvdXBQYXR0ZXJufSAke3NvcnRQYXR0ZXJufSAke2xpbWl0UGF0dGVybn1gO1xuICAgIGNvbnN0IHFzID0gZXhwbGFpbiA/IHRoaXMuY3JlYXRlRXhwbGFpbmFibGVRdWVyeShvcmlnaW5hbFF1ZXJ5KSA6IG9yaWdpbmFsUXVlcnk7XG4gICAgcmV0dXJuIHRoaXMuX2NsaWVudC5hbnkocXMsIHZhbHVlcykudGhlbihhID0+IHtcbiAgICAgIGlmIChleHBsYWluKSB7XG4gICAgICAgIHJldHVybiBhO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVzdWx0cyA9IGEubWFwKG9iamVjdCA9PiB0aGlzLnBvc3RncmVzT2JqZWN0VG9QYXJzZU9iamVjdChjbGFzc05hbWUsIG9iamVjdCwgc2NoZW1hKSk7XG4gICAgICByZXN1bHRzLmZvckVhY2gocmVzdWx0ID0+IHtcbiAgICAgICAgaWYgKCFPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzdWx0LCAnb2JqZWN0SWQnKSkge1xuICAgICAgICAgIHJlc3VsdC5vYmplY3RJZCA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGdyb3VwVmFsdWVzKSB7XG4gICAgICAgICAgcmVzdWx0Lm9iamVjdElkID0ge307XG4gICAgICAgICAgZm9yIChjb25zdCBrZXkgaW4gZ3JvdXBWYWx1ZXMpIHtcbiAgICAgICAgICAgIHJlc3VsdC5vYmplY3RJZFtrZXldID0gcmVzdWx0W2tleV07XG4gICAgICAgICAgICBkZWxldGUgcmVzdWx0W2tleV07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChjb3VudEZpZWxkKSB7XG4gICAgICAgICAgcmVzdWx0W2NvdW50RmllbGRdID0gcGFyc2VJbnQocmVzdWx0W2NvdW50RmllbGRdLCAxMCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBwZXJmb3JtSW5pdGlhbGl6YXRpb24oeyBWb2xhdGlsZUNsYXNzZXNTY2hlbWFzIH06IGFueSkge1xuICAgIC8vIFRPRE86IFRoaXMgbWV0aG9kIG5lZWRzIHRvIGJlIHJld3JpdHRlbiB0byBtYWtlIHByb3BlciB1c2Ugb2YgY29ubmVjdGlvbnMgKEB2aXRhbHktdClcbiAgICBkZWJ1ZygncGVyZm9ybUluaXRpYWxpemF0aW9uJyk7XG4gICAgYXdhaXQgdGhpcy5fZW5zdXJlU2NoZW1hQ29sbGVjdGlvbkV4aXN0cygpO1xuICAgIGNvbnN0IHByb21pc2VzID0gVm9sYXRpbGVDbGFzc2VzU2NoZW1hcy5tYXAoc2NoZW1hID0+IHtcbiAgICAgIHJldHVybiB0aGlzLmNyZWF0ZVRhYmxlKHNjaGVtYS5jbGFzc05hbWUsIHNjaGVtYSlcbiAgICAgICAgLmNhdGNoKGVyciA9PiB7XG4gICAgICAgICAgaWYgKFxuICAgICAgICAgICAgZXJyLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciB8fFxuICAgICAgICAgICAgZXJyLmNvZGUgPT09IFBhcnNlLkVycm9yLklOVkFMSURfQ0xBU1NfTkFNRVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHRoaXMuc2NoZW1hVXBncmFkZShzY2hlbWEuY2xhc3NOYW1lLCBzY2hlbWEpKTtcbiAgICB9KTtcbiAgICBwcm9taXNlcy5wdXNoKHRoaXMuX2xpc3RlblRvU2NoZW1hKCkpO1xuICAgIHJldHVybiBQcm9taXNlLmFsbChwcm9taXNlcylcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2NsaWVudC50eCgncGVyZm9ybS1pbml0aWFsaXphdGlvbicsIGFzeW5jIHQgPT4ge1xuICAgICAgICAgIGF3YWl0IHQubm9uZShzcWwubWlzYy5qc29uT2JqZWN0U2V0S2V5cyk7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKHNxbC5hcnJheS5hZGQpO1xuICAgICAgICAgIGF3YWl0IHQubm9uZShzcWwuYXJyYXkuYWRkVW5pcXVlKTtcbiAgICAgICAgICBhd2FpdCB0Lm5vbmUoc3FsLmFycmF5LnJlbW92ZSk7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKHNxbC5hcnJheS5jb250YWluc0FsbCk7XG4gICAgICAgICAgYXdhaXQgdC5ub25lKHNxbC5hcnJheS5jb250YWluc0FsbFJlZ2V4KTtcbiAgICAgICAgICBhd2FpdCB0Lm5vbmUoc3FsLmFycmF5LmNvbnRhaW5zKTtcbiAgICAgICAgICByZXR1cm4gdC5jdHg7XG4gICAgICAgIH0pO1xuICAgICAgfSlcbiAgICAgIC50aGVuKGN0eCA9PiB7XG4gICAgICAgIGRlYnVnKGBpbml0aWFsaXphdGlvbkRvbmUgaW4gJHtjdHguZHVyYXRpb259YCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKGVycm9yID0+IHtcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS5lcnJvcihlcnJvcik7XG4gICAgICB9KTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZUluZGV4ZXMoY2xhc3NOYW1lOiBzdHJpbmcsIGluZGV4ZXM6IGFueSwgY29ubjogP2FueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiAoY29ubiB8fCB0aGlzLl9jbGllbnQpLnR4KHQgPT5cbiAgICAgIHQuYmF0Y2goXG4gICAgICAgIGluZGV4ZXMubWFwKGkgPT4ge1xuICAgICAgICAgIHJldHVybiB0Lm5vbmUoJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTICQxOm5hbWUgT04gJDI6bmFtZSAoJDM6bmFtZSknLCBbXG4gICAgICAgICAgICBpLm5hbWUsXG4gICAgICAgICAgICBjbGFzc05hbWUsXG4gICAgICAgICAgICBpLmtleSxcbiAgICAgICAgICBdKTtcbiAgICAgICAgfSlcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgYXN5bmMgY3JlYXRlSW5kZXhlc0lmTmVlZGVkKFxuICAgIGNsYXNzTmFtZTogc3RyaW5nLFxuICAgIGZpZWxkTmFtZTogc3RyaW5nLFxuICAgIHR5cGU6IGFueSxcbiAgICBjb25uOiA/YW55XG4gICk6IFByb21pc2U8dm9pZD4ge1xuICAgIGF3YWl0IChjb25uIHx8IHRoaXMuX2NsaWVudCkubm9uZSgnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgJDE6bmFtZSBPTiAkMjpuYW1lICgkMzpuYW1lKScsIFtcbiAgICAgIGZpZWxkTmFtZSxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIHR5cGUsXG4gICAgXSk7XG4gIH1cblxuICBhc3luYyBkcm9wSW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZywgaW5kZXhlczogYW55LCBjb25uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBxdWVyaWVzID0gaW5kZXhlcy5tYXAoaSA9PiAoe1xuICAgICAgcXVlcnk6ICdEUk9QIElOREVYICQxOm5hbWUnLFxuICAgICAgdmFsdWVzOiBpLFxuICAgIH0pKTtcbiAgICBhd2FpdCAoY29ubiB8fCB0aGlzLl9jbGllbnQpLnR4KHQgPT4gdC5ub25lKHRoaXMuX3BncC5oZWxwZXJzLmNvbmNhdChxdWVyaWVzKSkpO1xuICB9XG5cbiAgYXN5bmMgZ2V0SW5kZXhlcyhjbGFzc05hbWU6IHN0cmluZykge1xuICAgIGNvbnN0IHFzID0gJ1NFTEVDVCAqIEZST00gcGdfaW5kZXhlcyBXSEVSRSB0YWJsZW5hbWUgPSAke2NsYXNzTmFtZX0nO1xuICAgIHJldHVybiB0aGlzLl9jbGllbnQuYW55KHFzLCB7IGNsYXNzTmFtZSB9KTtcbiAgfVxuXG4gIGFzeW5jIHVwZGF0ZVNjaGVtYVdpdGhJbmRleGVzKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgfVxuXG4gIC8vIFVzZWQgZm9yIHRlc3RpbmcgcHVycG9zZXNcbiAgYXN5bmMgdXBkYXRlRXN0aW1hdGVkQ291bnQoY2xhc3NOYW1lOiBzdHJpbmcpIHtcbiAgICByZXR1cm4gdGhpcy5fY2xpZW50Lm5vbmUoJ0FOQUxZWkUgJDE6bmFtZScsIFtjbGFzc05hbWVdKTtcbiAgfVxuXG4gIGFzeW5jIGNyZWF0ZVRyYW5zYWN0aW9uYWxTZXNzaW9uKCk6IFByb21pc2U8YW55PiB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKHJlc29sdmUgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb25hbFNlc3Npb24gPSB7fTtcbiAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnJlc3VsdCA9IHRoaXMuX2NsaWVudC50eCh0ID0+IHtcbiAgICAgICAgdHJhbnNhY3Rpb25hbFNlc3Npb24udCA9IHQ7XG4gICAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnByb21pc2UgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgICAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXNvbHZlID0gcmVzb2x2ZTtcbiAgICAgICAgfSk7XG4gICAgICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLmJhdGNoID0gW107XG4gICAgICAgIHJlc29sdmUodHJhbnNhY3Rpb25hbFNlc3Npb24pO1xuICAgICAgICByZXR1cm4gdHJhbnNhY3Rpb25hbFNlc3Npb24ucHJvbWlzZTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgY29tbWl0VHJhbnNhY3Rpb25hbFNlc3Npb24odHJhbnNhY3Rpb25hbFNlc3Npb246IGFueSk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnJlc29sdmUodHJhbnNhY3Rpb25hbFNlc3Npb24udC5iYXRjaCh0cmFuc2FjdGlvbmFsU2Vzc2lvbi5iYXRjaCkpO1xuICAgIHJldHVybiB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXN1bHQ7XG4gIH1cblxuICBhYm9ydFRyYW5zYWN0aW9uYWxTZXNzaW9uKHRyYW5zYWN0aW9uYWxTZXNzaW9uOiBhbnkpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCByZXN1bHQgPSB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5yZXN1bHQuY2F0Y2goKTtcbiAgICB0cmFuc2FjdGlvbmFsU2Vzc2lvbi5iYXRjaC5wdXNoKFByb21pc2UucmVqZWN0KCkpO1xuICAgIHRyYW5zYWN0aW9uYWxTZXNzaW9uLnJlc29sdmUodHJhbnNhY3Rpb25hbFNlc3Npb24udC5iYXRjaCh0cmFuc2FjdGlvbmFsU2Vzc2lvbi5iYXRjaCkpO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICBhc3luYyBlbnN1cmVJbmRleChcbiAgICBjbGFzc05hbWU6IHN0cmluZyxcbiAgICBzY2hlbWE6IFNjaGVtYVR5cGUsXG4gICAgZmllbGROYW1lczogc3RyaW5nW10sXG4gICAgaW5kZXhOYW1lOiA/c3RyaW5nLFxuICAgIGNhc2VJbnNlbnNpdGl2ZTogYm9vbGVhbiA9IGZhbHNlLFxuICAgIG9wdGlvbnM/OiBPYmplY3QgPSB7fVxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGNvbm4gPSBvcHRpb25zLmNvbm4gIT09IHVuZGVmaW5lZCA/IG9wdGlvbnMuY29ubiA6IHRoaXMuX2NsaWVudDtcbiAgICBjb25zdCBkZWZhdWx0SW5kZXhOYW1lID0gYHBhcnNlX2RlZmF1bHRfJHtmaWVsZE5hbWVzLnNvcnQoKS5qb2luKCdfJyl9YDtcbiAgICBjb25zdCBpbmRleE5hbWVPcHRpb25zOiBPYmplY3QgPVxuICAgICAgaW5kZXhOYW1lICE9IG51bGwgPyB7IG5hbWU6IGluZGV4TmFtZSB9IDogeyBuYW1lOiBkZWZhdWx0SW5kZXhOYW1lIH07XG4gICAgY29uc3QgY29uc3RyYWludFBhdHRlcm5zID0gY2FzZUluc2Vuc2l0aXZlXG4gICAgICA/IGZpZWxkTmFtZXMubWFwKChmaWVsZE5hbWUsIGluZGV4KSA9PiBgbG93ZXIoJCR7aW5kZXggKyAzfTpuYW1lKSB2YXJjaGFyX3BhdHRlcm5fb3BzYClcbiAgICAgIDogZmllbGROYW1lcy5tYXAoKGZpZWxkTmFtZSwgaW5kZXgpID0+IGAkJHtpbmRleCArIDN9Om5hbWVgKTtcbiAgICBjb25zdCBxcyA9IGBDUkVBVEUgSU5ERVggSUYgTk9UIEVYSVNUUyAkMTpuYW1lIE9OICQyOm5hbWUgKCR7Y29uc3RyYWludFBhdHRlcm5zLmpvaW4oKX0pYDtcbiAgICBjb25zdCBzZXRJZGVtcG90ZW5jeUZ1bmN0aW9uID1cbiAgICAgIG9wdGlvbnMuc2V0SWRlbXBvdGVuY3lGdW5jdGlvbiAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5zZXRJZGVtcG90ZW5jeUZ1bmN0aW9uIDogZmFsc2U7XG4gICAgaWYgKHNldElkZW1wb3RlbmN5RnVuY3Rpb24pIHtcbiAgICAgIGF3YWl0IHRoaXMuZW5zdXJlSWRlbXBvdGVuY3lGdW5jdGlvbkV4aXN0cyhvcHRpb25zKTtcbiAgICB9XG4gICAgYXdhaXQgY29ubi5ub25lKHFzLCBbaW5kZXhOYW1lT3B0aW9ucy5uYW1lLCBjbGFzc05hbWUsIC4uLmZpZWxkTmFtZXNdKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICBpZiAoXG4gICAgICAgIGVycm9yLmNvZGUgPT09IFBvc3RncmVzRHVwbGljYXRlUmVsYXRpb25FcnJvciAmJlxuICAgICAgICBlcnJvci5tZXNzYWdlLmluY2x1ZGVzKGluZGV4TmFtZU9wdGlvbnMubmFtZSlcbiAgICAgICkge1xuICAgICAgICAvLyBJbmRleCBhbHJlYWR5IGV4aXN0cy4gSWdub3JlIGVycm9yLlxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgZXJyb3IuY29kZSA9PT0gUG9zdGdyZXNVbmlxdWVJbmRleFZpb2xhdGlvbkVycm9yICYmXG4gICAgICAgIGVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoaW5kZXhOYW1lT3B0aW9ucy5uYW1lKVxuICAgICAgKSB7XG4gICAgICAgIC8vIENhc3QgdGhlIGVycm9yIGludG8gdGhlIHByb3BlciBwYXJzZSBlcnJvclxuICAgICAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICAgICAgUGFyc2UuRXJyb3IuRFVQTElDQVRFX1ZBTFVFLFxuICAgICAgICAgICdBIGR1cGxpY2F0ZSB2YWx1ZSBmb3IgYSBmaWVsZCB3aXRoIHVuaXF1ZSB2YWx1ZXMgd2FzIHByb3ZpZGVkJ1xuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBkZWxldGVJZGVtcG90ZW5jeUZ1bmN0aW9uKG9wdGlvbnM/OiBPYmplY3QgPSB7fSk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgY29ubiA9IG9wdGlvbnMuY29ubiAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5jb25uIDogdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHFzID0gJ0RST1AgRlVOQ1RJT04gSUYgRVhJU1RTIGlkZW1wb3RlbmN5X2RlbGV0ZV9leHBpcmVkX3JlY29yZHMoKSc7XG4gICAgcmV0dXJuIGNvbm4ubm9uZShxcykuY2F0Y2goZXJyb3IgPT4ge1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfSk7XG4gIH1cblxuICBhc3luYyBlbnN1cmVJZGVtcG90ZW5jeUZ1bmN0aW9uRXhpc3RzKG9wdGlvbnM/OiBPYmplY3QgPSB7fSk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3QgY29ubiA9IG9wdGlvbnMuY29ubiAhPT0gdW5kZWZpbmVkID8gb3B0aW9ucy5jb25uIDogdGhpcy5fY2xpZW50O1xuICAgIGNvbnN0IHR0bE9wdGlvbnMgPSBvcHRpb25zLnR0bCAhPT0gdW5kZWZpbmVkID8gYCR7b3B0aW9ucy50dGx9IHNlY29uZHNgIDogJzYwIHNlY29uZHMnO1xuICAgIGNvbnN0IHFzID1cbiAgICAgICdDUkVBVEUgT1IgUkVQTEFDRSBGVU5DVElPTiBpZGVtcG90ZW5jeV9kZWxldGVfZXhwaXJlZF9yZWNvcmRzKCkgUkVUVVJOUyB2b2lkIExBTkdVQUdFIHBscGdzcWwgQVMgJCQgQkVHSU4gREVMRVRFIEZST00gXCJfSWRlbXBvdGVuY3lcIiBXSEVSRSBleHBpcmUgPCBOT1coKSAtIElOVEVSVkFMICQxOyBFTkQ7ICQkOyc7XG4gICAgcmV0dXJuIGNvbm4ubm9uZShxcywgW3R0bE9wdGlvbnNdKS5jYXRjaChlcnJvciA9PiB7XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb252ZXJ0UG9seWdvblRvU1FMKHBvbHlnb24pIHtcbiAgaWYgKHBvbHlnb24ubGVuZ3RoIDwgMykge1xuICAgIHRocm93IG5ldyBQYXJzZS5FcnJvcihQYXJzZS5FcnJvci5JTlZBTElEX0pTT04sIGBQb2x5Z29uIG11c3QgaGF2ZSBhdCBsZWFzdCAzIHZhbHVlc2ApO1xuICB9XG4gIGlmIChcbiAgICBwb2x5Z29uWzBdWzBdICE9PSBwb2x5Z29uW3BvbHlnb24ubGVuZ3RoIC0gMV1bMF0gfHxcbiAgICBwb2x5Z29uWzBdWzFdICE9PSBwb2x5Z29uW3BvbHlnb24ubGVuZ3RoIC0gMV1bMV1cbiAgKSB7XG4gICAgcG9seWdvbi5wdXNoKHBvbHlnb25bMF0pO1xuICB9XG4gIGNvbnN0IHVuaXF1ZSA9IHBvbHlnb24uZmlsdGVyKChpdGVtLCBpbmRleCwgYXIpID0+IHtcbiAgICBsZXQgZm91bmRJbmRleCA9IC0xO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXIubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgIGNvbnN0IHB0ID0gYXJbaV07XG4gICAgICBpZiAocHRbMF0gPT09IGl0ZW1bMF0gJiYgcHRbMV0gPT09IGl0ZW1bMV0pIHtcbiAgICAgICAgZm91bmRJbmRleCA9IGk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZm91bmRJbmRleCA9PT0gaW5kZXg7XG4gIH0pO1xuICBpZiAodW5pcXVlLmxlbmd0aCA8IDMpIHtcbiAgICB0aHJvdyBuZXcgUGFyc2UuRXJyb3IoXG4gICAgICBQYXJzZS5FcnJvci5JTlRFUk5BTF9TRVJWRVJfRVJST1IsXG4gICAgICAnR2VvSlNPTjogTG9vcCBtdXN0IGhhdmUgYXQgbGVhc3QgMyBkaWZmZXJlbnQgdmVydGljZXMnXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb2ludHMgPSBwb2x5Z29uXG4gICAgLm1hcChwb2ludCA9PiB7XG4gICAgICBQYXJzZS5HZW9Qb2ludC5fdmFsaWRhdGUocGFyc2VGbG9hdChwb2ludFsxXSksIHBhcnNlRmxvYXQocG9pbnRbMF0pKTtcbiAgICAgIHJldHVybiBgKCR7cG9pbnRbMV19LCAke3BvaW50WzBdfSlgO1xuICAgIH0pXG4gICAgLmpvaW4oJywgJyk7XG4gIHJldHVybiBgKCR7cG9pbnRzfSlgO1xufVxuXG5mdW5jdGlvbiByZW1vdmVXaGl0ZVNwYWNlKHJlZ2V4KSB7XG4gIGlmICghcmVnZXguZW5kc1dpdGgoJ1xcbicpKSB7XG4gICAgcmVnZXggKz0gJ1xcbic7XG4gIH1cblxuICAvLyByZW1vdmUgbm9uIGVzY2FwZWQgY29tbWVudHNcbiAgcmV0dXJuIChcbiAgICByZWdleFxuICAgICAgLnJlcGxhY2UoLyhbXlxcXFxdKSMuKlxcbi9naW0sICckMScpXG4gICAgICAvLyByZW1vdmUgbGluZXMgc3RhcnRpbmcgd2l0aCBhIGNvbW1lbnRcbiAgICAgIC5yZXBsYWNlKC9eIy4qXFxuL2dpbSwgJycpXG4gICAgICAvLyByZW1vdmUgbm9uIGVzY2FwZWQgd2hpdGVzcGFjZVxuICAgICAgLnJlcGxhY2UoLyhbXlxcXFxdKVxccysvZ2ltLCAnJDEnKVxuICAgICAgLy8gcmVtb3ZlIHdoaXRlc3BhY2UgYXQgdGhlIGJlZ2lubmluZyBvZiBhIGxpbmVcbiAgICAgIC5yZXBsYWNlKC9eXFxzKy8sICcnKVxuICAgICAgLnRyaW0oKVxuICApO1xufVxuXG5mdW5jdGlvbiBwcm9jZXNzUmVnZXhQYXR0ZXJuKHMpIHtcbiAgaWYgKHMgJiYgcy5zdGFydHNXaXRoKCdeJykpIHtcbiAgICAvLyByZWdleCBmb3Igc3RhcnRzV2l0aFxuICAgIHJldHVybiAnXicgKyBsaXRlcmFsaXplUmVnZXhQYXJ0KHMuc2xpY2UoMSkpO1xuICB9IGVsc2UgaWYgKHMgJiYgcy5lbmRzV2l0aCgnJCcpKSB7XG4gICAgLy8gcmVnZXggZm9yIGVuZHNXaXRoXG4gICAgcmV0dXJuIGxpdGVyYWxpemVSZWdleFBhcnQocy5zbGljZSgwLCBzLmxlbmd0aCAtIDEpKSArICckJztcbiAgfVxuXG4gIC8vIHJlZ2V4IGZvciBjb250YWluc1xuICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChzKTtcbn1cblxuZnVuY3Rpb24gaXNTdGFydHNXaXRoUmVnZXgodmFsdWUpIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09ICdzdHJpbmcnIHx8ICF2YWx1ZS5zdGFydHNXaXRoKCdeJykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBjb25zdCBtYXRjaGVzID0gdmFsdWUubWF0Y2goL1xcXlxcXFxRLipcXFxcRS8pO1xuICByZXR1cm4gISFtYXRjaGVzO1xufVxuXG5mdW5jdGlvbiBpc0FsbFZhbHVlc1JlZ2V4T3JOb25lKHZhbHVlcykge1xuICBpZiAoIXZhbHVlcyB8fCAhQXJyYXkuaXNBcnJheSh2YWx1ZXMpIHx8IHZhbHVlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGNvbnN0IGZpcnN0VmFsdWVzSXNSZWdleCA9IGlzU3RhcnRzV2l0aFJlZ2V4KHZhbHVlc1swXS4kcmVnZXgpO1xuICBpZiAodmFsdWVzLmxlbmd0aCA9PT0gMSkge1xuICAgIHJldHVybiBmaXJzdFZhbHVlc0lzUmVnZXg7XG4gIH1cblxuICBmb3IgKGxldCBpID0gMSwgbGVuZ3RoID0gdmFsdWVzLmxlbmd0aDsgaSA8IGxlbmd0aDsgKytpKSB7XG4gICAgaWYgKGZpcnN0VmFsdWVzSXNSZWdleCAhPT0gaXNTdGFydHNXaXRoUmVnZXgodmFsdWVzW2ldLiRyZWdleCkpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gaXNBbnlWYWx1ZVJlZ2V4U3RhcnRzV2l0aCh2YWx1ZXMpIHtcbiAgcmV0dXJuIHZhbHVlcy5zb21lKGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgIHJldHVybiBpc1N0YXJ0c1dpdGhSZWdleCh2YWx1ZS4kcmVnZXgpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gY3JlYXRlTGl0ZXJhbFJlZ2V4KHJlbWFpbmluZzogc3RyaW5nKSB7XG4gIHJldHVybiByZW1haW5pbmdcbiAgICAuc3BsaXQoJycpXG4gICAgLm1hcChjID0+IHtcbiAgICAgIGNvbnN0IHJlZ2V4ID0gUmVnRXhwKCdbMC05IF18XFxcXHB7TH0nLCAndScpOyAvLyBTdXBwb3J0IGFsbCBVbmljb2RlIGxldHRlciBjaGFyc1xuICAgICAgaWYgKGMubWF0Y2gocmVnZXgpICE9PSBudWxsKSB7XG4gICAgICAgIC8vIERvbid0IGVzY2FwZSBhbHBoYW51bWVyaWMgY2hhcmFjdGVyc1xuICAgICAgICByZXR1cm4gYztcbiAgICAgIH1cbiAgICAgIC8vIEVzY2FwZSBldmVyeXRoaW5nIGVsc2UgKHNpbmdsZSBxdW90ZXMgd2l0aCBzaW5nbGUgcXVvdGVzLCBldmVyeXRoaW5nIGVsc2Ugd2l0aCBhIGJhY2tzbGFzaClcbiAgICAgIHJldHVybiBjID09PSBgJ2AgPyBgJydgIDogYFxcXFwke2N9YDtcbiAgICB9KVxuICAgIC5qb2luKCcnKTtcbn1cblxuZnVuY3Rpb24gbGl0ZXJhbGl6ZVJlZ2V4UGFydChzOiBzdHJpbmcpIHtcbiAgY29uc3QgbWF0Y2hlcjEgPSAvXFxcXFEoKD8hXFxcXEUpLiopXFxcXEUkLztcbiAgY29uc3QgcmVzdWx0MTogYW55ID0gcy5tYXRjaChtYXRjaGVyMSk7XG4gIGlmIChyZXN1bHQxICYmIHJlc3VsdDEubGVuZ3RoID4gMSAmJiByZXN1bHQxLmluZGV4ID4gLTEpIHtcbiAgICAvLyBQcm9jZXNzIFJlZ2V4IHRoYXQgaGFzIGEgYmVnaW5uaW5nIGFuZCBhbiBlbmQgc3BlY2lmaWVkIGZvciB0aGUgbGl0ZXJhbCB0ZXh0XG4gICAgY29uc3QgcHJlZml4ID0gcy5zdWJzdHJpbmcoMCwgcmVzdWx0MS5pbmRleCk7XG4gICAgY29uc3QgcmVtYWluaW5nID0gcmVzdWx0MVsxXTtcblxuICAgIHJldHVybiBsaXRlcmFsaXplUmVnZXhQYXJ0KHByZWZpeCkgKyBjcmVhdGVMaXRlcmFsUmVnZXgocmVtYWluaW5nKTtcbiAgfVxuXG4gIC8vIFByb2Nlc3MgUmVnZXggdGhhdCBoYXMgYSBiZWdpbm5pbmcgc3BlY2lmaWVkIGZvciB0aGUgbGl0ZXJhbCB0ZXh0XG4gIGNvbnN0IG1hdGNoZXIyID0gL1xcXFxRKCg/IVxcXFxFKS4qKSQvO1xuICBjb25zdCByZXN1bHQyOiBhbnkgPSBzLm1hdGNoKG1hdGNoZXIyKTtcbiAgaWYgKHJlc3VsdDIgJiYgcmVzdWx0Mi5sZW5ndGggPiAxICYmIHJlc3VsdDIuaW5kZXggPiAtMSkge1xuICAgIGNvbnN0IHByZWZpeCA9IHMuc3Vic3RyaW5nKDAsIHJlc3VsdDIuaW5kZXgpO1xuICAgIGNvbnN0IHJlbWFpbmluZyA9IHJlc3VsdDJbMV07XG5cbiAgICByZXR1cm4gbGl0ZXJhbGl6ZVJlZ2V4UGFydChwcmVmaXgpICsgY3JlYXRlTGl0ZXJhbFJlZ2V4KHJlbWFpbmluZyk7XG4gIH1cblxuICAvLyBSZW1vdmUgcHJvYmxlbWF0aWMgY2hhcnMgZnJvbSByZW1haW5pbmcgdGV4dFxuICByZXR1cm4gc1xuICAgIC8vIFJlbW92ZSBhbGwgaW5zdGFuY2VzIG9mIFxcUSBhbmQgXFxFXG4gICAgLnJlcGxhY2UoLyhbXlxcXFxdKShcXFxcRSkvLCAnJDEnKVxuICAgIC5yZXBsYWNlKC8oW15cXFxcXSkoXFxcXFEpLywgJyQxJylcbiAgICAucmVwbGFjZSgvXlxcXFxFLywgJycpXG4gICAgLnJlcGxhY2UoL15cXFxcUS8sICcnKVxuICAgIC8vIEVuc3VyZSBldmVuIG51bWJlciBvZiBzaW5nbGUgcXVvdGUgc2VxdWVuY2VzIGJ5IGFkZGluZyBhbiBleHRyYSBzaW5nbGUgcXVvdGUgaWYgbmVlZGVkO1xuICAgIC8vIHRoaXMgZW5zdXJlcyB0aGF0IGV2ZXJ5IHNpbmdsZSBxdW90ZSBpcyBlc2NhcGVkXG4gICAgLnJlcGxhY2UoLycrL2csIG1hdGNoID0+IHtcbiAgICAgIHJldHVybiBtYXRjaC5sZW5ndGggJSAyID09PSAwID8gbWF0Y2ggOiBtYXRjaCArIFwiJ1wiO1xuICAgIH0pO1xufVxuXG52YXIgR2VvUG9pbnRDb2RlciA9IHtcbiAgaXNWYWxpZEpTT04odmFsdWUpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiB2YWx1ZS5fX3R5cGUgPT09ICdHZW9Qb2ludCc7XG4gIH0sXG59O1xuXG5leHBvcnQgZGVmYXVsdCBQb3N0Z3Jlc1N0b3JhZ2VBZGFwdGVyO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7QUFDQSxJQUFBQSxlQUFBLEdBQUFDLE9BQUE7QUFFQSxJQUFBQyxLQUFBLEdBQUFDLHNCQUFBLENBQUFGLE9BQUE7QUFFQSxJQUFBRyxPQUFBLEdBQUFELHNCQUFBLENBQUFGLE9BQUE7QUFFQSxJQUFBSSxPQUFBLEdBQUFKLE9BQUE7QUFDQSxJQUFBSyxJQUFBLEdBQUFILHNCQUFBLENBQUFGLE9BQUE7QUFDQSxJQUFBTSxlQUFBLEdBQUFOLE9BQUE7QUFBbUQsU0FBQUUsdUJBQUFLLENBQUEsV0FBQUEsQ0FBQSxJQUFBQSxDQUFBLENBQUFDLFVBQUEsR0FBQUQsQ0FBQSxLQUFBRSxPQUFBLEVBQUFGLENBQUE7QUFQbkQ7QUFFQTtBQUVBO0FBS0EsTUFBTUcsS0FBSyxHQUFHVixPQUFPLENBQUMsZ0JBQWdCLENBQUM7QUFFdkMsTUFBTVcsaUNBQWlDLEdBQUcsT0FBTztBQUNqRCxNQUFNQyw4QkFBOEIsR0FBRyxPQUFPO0FBQzlDLE1BQU1DLDRCQUE0QixHQUFHLE9BQU87QUFDNUMsTUFBTUMsMEJBQTBCLEdBQUcsT0FBTztBQUMxQyxNQUFNQyxpQ0FBaUMsR0FBRyxPQUFPO0FBQ2pELE1BQU1DLE1BQU0sR0FBR2hCLE9BQU8sQ0FBQyxpQkFBaUIsQ0FBQztBQUV6QyxNQUFNaUIsS0FBSyxHQUFHLFNBQUFBLENBQVUsR0FBR0MsSUFBUyxFQUFFO0VBQ3BDQSxJQUFJLEdBQUcsQ0FBQyxNQUFNLEdBQUdDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDQyxNQUFNLENBQUNGLElBQUksQ0FBQ0csS0FBSyxDQUFDLENBQUMsRUFBRUgsSUFBSSxDQUFDSSxNQUFNLENBQUMsQ0FBQztFQUNqRSxNQUFNQyxHQUFHLEdBQUdQLE1BQU0sQ0FBQ1EsU0FBUyxDQUFDLENBQUM7RUFDOUJELEdBQUcsQ0FB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