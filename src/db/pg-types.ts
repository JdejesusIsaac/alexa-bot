import { types } from 'pg';

/**
 * Parse PostgreSQL `date` columns (OID 1082) as their raw 'YYYY-MM-DD'
 * string.
 *
 * node-postgres's default parser builds a JS Date at local midnight,
 * which is neither the value the row carries nor safe to round-trip
 * across timezones — a UTC+8 local midnight is the previous day in UTC.
 * The service date is a calendar grain (AD-31), not an instant; keep it
 * as the string the database stores.
 *
 * `service_date` is the only `date`-typed column in the schema (PL-201);
 * timestamps (`timestamptz`) keep their default Date parsing.
 */
types.setTypeParser(1082, (val: string) => val);
