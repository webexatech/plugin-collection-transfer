// Adapted from @nocobase/plugin-backup-restore (src/server/field-value-writer.ts), which does not export it.
// Converts values between their dumped (JSON) form and what the database layer expects on insert.

import { Database, DataTypes, Field } from '@nocobase/database';
import lodash from 'lodash';

type WriterFunc = (val: unknown, database: Database) => unknown;

const GEO_TYPES = ['point', 'lineString', 'circle', 'polygon'];

type FieldWithAccessors = Field & {
  options: Field['options'] & {
    set: (this: { setDataValue: (name: string, value: unknown) => void }, value: unknown) => void;
    get: (this: { getDataValue: () => unknown }) => unknown;
  };
};

export class FieldValueWriter {
  static writers = new Map<string, WriterFunc>();

  static write(field: Field, val: unknown, database: Database) {
    if (val === null) return val;

    if (GEO_TYPES.includes(field.type)) {
      let result = lodash.isString(val) ? JSON.parse(val) : val;
      const mockObj = {
        setDataValue: (_name: string, newVal: unknown) => {
          result = newVal;
        },
      };
      (field as FieldWithAccessors).options.set.call(mockObj, result);
      return result;
    }

    const writer = FieldValueWriter.writers.get(field.typeToString());
    return writer ? writer(val, database) : val;
  }

  static toDumpedValue(field: Field, val: unknown) {
    if (val === null) return val;

    if (GEO_TYPES.includes(field.type)) {
      return (field as FieldWithAccessors).options.get.call({ getDataValue: () => val });
    }

    return val;
  }

  static registerWriter(types: string | string[], writer: WriterFunc) {
    for (const type of lodash.castArray(types)) {
      FieldValueWriter.writers.set(type, writer);
    }
  }
}

function isJSONObjectOrArrayString(str: unknown) {
  if (typeof str !== 'string') return false;
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null;
  } catch (e) {
    return false;
  }
}

/** Formats an ISO instant as "YYYY-MM-DD HH:mm:ss" in a fixed "+HH:MM" offset (MySQL DATETIME without zone). */
function formatInOffset(iso: string, offset: string) {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  const minutes = match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

function isIso8601(str: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(str);
}

FieldValueWriter.registerWriter([DataTypes.JSON.toString(), DataTypes.JSONB.toString()], (val) =>
  isJSONObjectOrArrayString(val) ? JSON.parse(val as string) : val,
);

FieldValueWriter.registerWriter('DatetimeNoTzTypeMySQL', (val, database) => {
  const timezone = (database.options as { rawTimezone?: string }).rawTimezone || '+00:00';
  if (typeof val === 'string' && isIso8601(val)) {
    return formatInOffset(val, timezone);
  }
  return val;
});

FieldValueWriter.registerWriter(DataTypes.BOOLEAN.toString(), (val) => Boolean(val));
