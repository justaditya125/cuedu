const mysql = require('mysql2/promise');

// The student data lives in MySQL (tables exam_batches / exam_students /
// exam_subjects / exam_reattempts), loaded from the result spreadsheets by
// scripts/import-results.py + scripts/export-mysql.py. The app only ever
// reads, so give it an account with SELECT and nothing else.
//
//   RESULTS_DB_HOST      default 127.0.0.1
//   RESULTS_DB_PORT      default 3306
//   RESULTS_DB_USER      required
//   RESULTS_DB_PASSWORD
//   RESULTS_DB_NAME      required

const ORDINALS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];
const QUERY_TIMEOUT_MS = Number(process.env.RESULTS_DB_TIMEOUT_MS) || 8000;

// Raised when the database cannot be used at all (not configured, unreachable,
// wrong credentials, tables missing). Callers answer 503 for it, not 500.
class ResultsUnavailableError extends Error {}

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_CON_COUNT_ERROR'
]);

function config() {
  const database = process.env.RESULTS_DB_NAME;
  const user = process.env.RESULTS_DB_USER;
  if (!database || !user) return null;
  return {
    host: process.env.RESULTS_DB_HOST || '127.0.0.1',
    port: Number(process.env.RESULTS_DB_PORT) || 3306,
    user,
    password: process.env.RESULTS_DB_PASSWORD || '',
    database
  };
}

function isConfigured() {
  return config() !== null;
}

let pool = null;

function getPool() {
  const cfg = config();
  if (!cfg) {
    throw new ResultsUnavailableError('results database is not configured (set RESULTS_DB_NAME and RESULTS_DB_USER)');
  }
  if (!pool) {
    pool = mysql.createPool(Object.assign({}, cfg, {
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 50,
      connectTimeout: 5000
    }));
  }
  return pool;
}

async function query(sql, values) {
  try {
    const [rows] = await getPool().query({ sql, values, timeout: QUERY_TIMEOUT_MS });
    return rows;
  } catch (err) {
    if (err instanceof ResultsUnavailableError) throw err;
    if (UNAVAILABLE_CODES.has(err.code) || err.fatal) {
      throw new ResultsUnavailableError(err.code || err.message);
    }
    throw err;
  }
}

// Cheap reachability check used at startup: resolves to the number of students
// loaded, or rejects with ResultsUnavailableError.
async function ping() {
  const rows = await query('SELECT COUNT(*) AS n FROM exam_students');
  return Number(rows[0].n);
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

// Registration numbers are matched exactly as stored; this only removes
// whitespace and normalises case so "2551 0285 0001" finds the same record.
function normalizeRegn(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9-]{6,20}$/.test(v) ? v : '';
}

function maskRegn(regn) {
  return regn.length > 4 ? '*'.repeat(regn.length - 4) + regn.slice(-4) : '****';
}

function upper(s) {
  return String(s || '').toUpperCase();
}

// Builds the memos for one registration number. Values are passed through
// exactly as stored: nothing is derived, merged or recomputed.
//
// Each statement reads all of its tables in one go, so a release that is swapped
// in while a lookup runs can never hand a student half of one release and half
// of another.
async function lookup(regn) {
  const memos = [];

  const rows = await query(
    'SELECT s.id AS student_id, s.name, s.enrollment_no, s.sgpa, s.final_result, ' +
    '       b.program, b.semester, b.exam_month, ' +
    '       sub.position AS sub_position, sub.subject_name, sub.grade, sub.grade_point ' +
    'FROM exam_students s ' +
    'JOIN exam_batches b ON b.id = s.batch_id ' +
    'LEFT JOIN exam_subjects sub ON sub.student_id = s.id ' +
    'WHERE s.enrollment_no = ? ' +
    'ORDER BY b.semester, b.id, s.id, sub.position',
    [regn]
  );

  const byStudent = new Map();
  for (const r of rows) {
    let memo = byStudent.get(r.student_id);
    if (!memo) {
      memo = {
        kind: 'semester',
        title: upper(r.program) + ' ' + upper(ORDINALS[r.semester]) + ' SEMESTER EXAMINATIONS HELD IN ' + r.exam_month,
        name: r.name,
        enrollmentNo: r.enrollment_no,
        abcId: '',                                   // not present in the source sheets
        program: r.program,
        mode: 'Online',
        subjects: [],
        sgpa: r.sgpa,
        result: r.final_result + ' in Semester-' + r.semester
      };
      byStudent.set(r.student_id, memo);
      memos.push(memo);
    }
    if (r.sub_position !== null) {
      memo.subjects.push({
        sno: memo.subjects.length + 1,
        name: r.subject_name,
        grade: r.grade,
        gradePoint: r.grade_point
      });
    }
  }

  const attempts = await query(
    'SELECT r.*, b.exam_month FROM exam_reattempts r ' +
    'JOIN exam_batches b ON b.id = r.batch_id ' +
    'WHERE r.enrollment_no = ? ' +
    'ORDER BY CAST(r.semester AS UNSIGNED), r.id',
    [regn]
  );

  // One memo per semester re-attempted.
  const bySemester = new Map();
  for (const r of attempts) {
    if (!bySemester.has(r.semester)) bySemester.set(r.semester, []);
    bySemester.get(r.semester).push(r);
  }
  for (const [semester, group] of bySemester) {
    const first = group[0];
    const ordinal = ORDINALS[Number(semester)] || ('Semester ' + semester);
    memos.push({
      kind: 'reattempt',
      title: upper(first.course) + ' ' + upper(ordinal) + ' SEMESTER RE-ATTEMPT EXAMINATIONS HELD IN ' + first.exam_month,
      name: first.student_name,
      enrollmentNo: first.enrollment_no,
      abcId: '',
      program: first.specialisation ? first.course + ' (' + first.specialisation + ')' : first.course,
      mode: 'Online',
      subjects: group.map((x, i) => ({
        sno: i + 1,
        name: x.subject_name,
        internal: x.internal,
        external: x.external,
        total: x.total,
        result: x.result
      }))
    });
  }

  return memos;
}

module.exports = { lookup, ping, close, isConfigured, normalizeRegn, maskRegn, ResultsUnavailableError };
