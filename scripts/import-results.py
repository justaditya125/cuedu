#!/usr/bin/env python3
"""Import the exam-result spreadsheets into a SQLite database, as-is.

Every cell value is stored as TEXT exactly as it appears in the sheet - no grade
derivation, no merging of re-attempts, no recomputed SGPA. The only structure
added is the relational shape (student -> subjects) needed to look a result up
by enrollment number.

    python3 scripts/import-results.py "EXAM DATA University Format" exam-data/results.db

The database is built in a temporary file and moved into place only on success,
so a failed import never replaces a working database. Run it with:  python3 -I
"""
import datetime
import glob
import os
import re
import sqlite3
import sys

import openpyxl

SCHEMA = """
CREATE TABLE batches (
  id           INTEGER PRIMARY KEY,
  kind         TEXT NOT NULL,          -- 'semester' (wide sheet) | 'reattempt' (long sheet)
  source_file  TEXT NOT NULL,
  program      TEXT,                   -- from the FILE NAME, e.g. 'MBA Finance'
  semester     INTEGER,
  exam_month   TEXT,                   -- e.g. 'Sep-2026'
  batch        TEXT,                   -- e.g. 'Jan 2025'
  sheet_title  TEXT,                   -- row 1, verbatim
  institution  TEXT,                   -- row 2, verbatim
  imported_at  TEXT NOT NULL
);
CREATE TABLE students (
  id                  INTEGER PRIMARY KEY,
  batch_id            INTEGER NOT NULL REFERENCES batches(id),
  sl_no               TEXT,
  enrollment_no       TEXT NOT NULL,
  name                TEXT,
  total_grade_point   TEXT,
  total_credit_point  TEXT,
  sgpa                TEXT,
  final_result        TEXT
);
CREATE INDEX idx_students_enr ON students(enrollment_no);
CREATE TABLE subjects (
  id            INTEGER PRIMARY KEY,
  student_id    INTEGER NOT NULL REFERENCES students(id),
  position      INTEGER NOT NULL,
  subject_name  TEXT,
  credit        TEXT,
  internal      TEXT,
  external      TEXT,
  total         TEXT,
  grade         TEXT,
  grade_point   TEXT,
  credit_point  TEXT
);
CREATE INDEX idx_subjects_student ON subjects(student_id);
CREATE TABLE reattempts (
  id               INTEGER PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES batches(id),
  university       TEXT,
  enrollment_no    TEXT NOT NULL,
  lead_id          TEXT,
  admission_batch  TEXT,
  student_name     TEXT,
  course           TEXT,
  specialisation   TEXT,
  semester         TEXT,
  subject_name     TEXT,
  exam_type        TEXT,
  internal         TEXT,
  external         TEXT,
  total            TEXT,
  result           TEXT
);
CREATE INDEX idx_reattempts_enr ON reattempts(enrollment_no);
"""

ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6}
SUBHEADERS = ["int", "ext", "total", "grade", "grade point", "credit point"]
TAIL_COLUMNS = {
    "total grade point": "total_grade_point",
    "total credit point": "total_credit_point",
    "sgpa": "sgpa",
    "final results": "final_result",
}
LONG_HEADER = [
    "University", "Enrollment Number", "Lead ID", "Admission Batch", "Student Name",
    "Course", "Specialisation", "Semester", "Subject Name", "Exam Type",
    "Internal", "External", "Total", "Result",
]


class ImportError_(Exception):
    pass


def text(v):
    """A cell as the text a person would read in the sheet. Nothing is derived."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, datetime.datetime):
        return v.date().isoformat() if (v.hour, v.minute, v.second) == (0, 0, 0) else v.isoformat(sep=" ")
    if isinstance(v, datetime.date):
        return v.isoformat()
    return str(v).strip()


def squash(s):
    return re.sub(r"\s+", " ", s or "").strip()


def load_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        return list(wb.worksheets[0].iter_rows(values_only=True))
    finally:
        wb.close()


def program_from_filename(name):
    """'MBA Finance Jan-25_Sem_03_Result.xlsx' -> 'MBA Finance'.

    The file name is used, not the sheet title: the MCA Jul-25 sheet's title
    reads 'BCA SECOND Semester' (a typo - its subjects are the MCA Semester II
    papers), and a wrong programme on a student's memo is worse than a wrong
    title in a spreadsheet nobody sees.
    """
    stem = os.path.splitext(os.path.basename(name))[0]
    m = re.match(r"^(.*?)\s+[A-Za-z]{3}-\d{2}_Sem_\d+_Result$", stem)
    if not m:
        raise ImportError_("cannot read the programme from file name: %r" % name)
    return squash(m.group(1))


def import_semester_sheet(con, path, rows, now):
    name = os.path.basename(path)
    if len(rows) < 7:
        raise ImportError_("%s: fewer than 7 rows" % name)

    title = text(rows[0][0])
    institution = text(rows[1][0])

    sem_m = re.search(r"\b(first|second|third|fourth|fifth|sixth)\b", title, re.I)
    month_m = re.search(r"Examination\s+Month\s*-\s*([A-Za-z]+)\s*(\d{4})", title, re.I)
    batch_m = re.search(r"([A-Za-z]+\s+\d{4})\s+Batch", title, re.I)
    if not sem_m or not month_m:
        raise ImportError_("%s: cannot read semester / exam month from title %r" % (name, title))

    semester = ORDINALS[sem_m.group(1).lower()]
    exam_month = "%s-%s" % (month_m.group(1)[:3].title(), month_m.group(2))
    batch = squash(batch_m.group(1)) if batch_m else ""

    credit_row, name_row, sub_row = rows[2], rows[4], rows[5]

    starts = [i for i, c in enumerate(sub_row) if i >= 3 and text(c).lower().startswith("int")]
    if not starts:
        raise ImportError_("%s: found no subject columns" % name)

    groups = []
    for st in starts:
        got = [text(sub_row[st + k]).lower() for k in range(6)]
        if [g[:len(s)] for g, s in zip(got, SUBHEADERS)] != SUBHEADERS:
            raise ImportError_("%s: unexpected sub-headers at column %d: %r" % (name, st, got))
        subject = text(name_row[st])
        m = re.search(r"(\d+(?:\.\d+)?)", text(credit_row[st]))     # tolerates 'Credit :4'
        if not subject:
            raise ImportError_("%s: subject column %d has no name" % (name, st))
        if not m:
            raise ImportError_("%s: no credit value for %r (%r)" % (name, subject, text(credit_row[st])))
        groups.append((st, subject, m.group(1)))

    tail = {}
    for i, c in enumerate(credit_row):
        key = TAIL_COLUMNS.get(text(c).lower())
        if key:
            tail[key] = i
    missing = set(TAIL_COLUMNS.values()) - set(tail)
    if missing:
        raise ImportError_("%s: missing result columns %s" % (name, sorted(missing)))

    cur = con.execute(
        "INSERT INTO batches(kind, source_file, program, semester, exam_month, batch, sheet_title, institution, imported_at)"
        " VALUES('semester',?,?,?,?,?,?,?,?)",
        (name, program_from_filename(name), semester, exam_month, batch, title, institution, now),
    )
    batch_id = cur.lastrowid

    n_students = n_blank_groups = 0
    for r in rows[6:]:
        enr = text(r[1])
        if not enr:
            continue
        sc = con.execute(
            "INSERT INTO students(batch_id, sl_no, enrollment_no, name, total_grade_point, total_credit_point, sgpa, final_result)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (batch_id, text(r[0]), enr, text(r[2]),
             text(r[tail["total_grade_point"]]), text(r[tail["total_credit_point"]]),
             text(r[tail["sgpa"]]), text(r[tail["final_result"]])),
        )
        n_students += 1
        pos = 0
        for st, subject, credit in groups:
            cells = [text(r[st + k]) for k in range(6)]
            if not any(cells):                       # a paper this student did not take
                n_blank_groups += 1
                continue
            pos += 1
            con.execute(
                "INSERT INTO subjects(student_id, position, subject_name, credit, internal, external, total, grade, grade_point, credit_point)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (sc.lastrowid, pos, subject, credit, *cells),
            )
    return "semester", n_students, "%d subject cols, %d blank" % (len(groups), n_blank_groups)


def import_reattempt_sheet(con, path, rows, now):
    name = os.path.basename(path)
    header = [text(c) for c in rows[0][:len(LONG_HEADER)]]
    if header != LONG_HEADER:
        raise ImportError_("%s: unexpected header %r" % (name, header))

    m = re.match(r"^([A-Za-z]{3})[A-Za-z]*\s*(\d{4})", name)
    exam_month = "%s-%s" % (m.group(1).title(), m.group(2)) if m else ""
    cur = con.execute(
        "INSERT INTO batches(kind, source_file, program, semester, exam_month, batch, sheet_title, institution, imported_at)"
        " VALUES('reattempt',?,?,?,?,?,?,?,?)",
        (name, "", None, exam_month, "", os.path.splitext(name)[0], "", now),
    )
    n = 0
    for r in rows[1:]:
        if not text(r[1]):
            continue
        con.execute(
            "INSERT INTO reattempts(batch_id, university, enrollment_no, lead_id, admission_batch, student_name, course,"
            " specialisation, semester, subject_name, exam_type, internal, external, total, result)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cur.lastrowid, *[text(c) for c in r[:len(LONG_HEADER)]]),
        )
        n += 1
    return "reattempt", n, ""


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: import-results.py <folder with .xlsx files> <output .db>")
    src, out = sys.argv[1], sys.argv[2]
    files = sorted(glob.glob(os.path.join(src, "**", "*.xlsx"), recursive=True))
    files = [f for f in files if not os.path.basename(f).startswith("~$")]
    if not files:
        sys.exit("no .xlsx files under %r" % src)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".importing"
    if os.path.exists(tmp):
        os.remove(tmp)

    con = sqlite3.connect(tmp)
    now = datetime.datetime.now().isoformat(timespec="seconds")
    try:
        con.executescript(SCHEMA)
        print("%-52s %-10s %6s  %s" % ("file", "kind", "rows", "note"))
        for f in files:
            rows = load_rows(f)
            is_long = bool(rows) and text(rows[0][0]) == "University" and "Exam Type" in [text(c) for c in rows[0]]
            kind, n, note = (import_reattempt_sheet if is_long else import_semester_sheet)(con, f, rows, now)
            print("%-52s %-10s %6d  %s" % (os.path.relpath(f, src)[:52], kind, n, note))

        dupes = con.execute(
            "SELECT enrollment_no, COUNT(*) c FROM students GROUP BY enrollment_no HAVING c > 1"
        ).fetchall()
        if dupes:
            print("\nNOTE: %d enrollment number(s) appear in more than one semester sheet: %s"
                  % (len(dupes), [d[0] for d in dupes[:5]]))
        orphans = con.execute(
            "SELECT COUNT(DISTINCT enrollment_no) FROM reattempts WHERE enrollment_no NOT IN (SELECT enrollment_no FROM students)"
        ).fetchone()[0]
        print("re-attempt students with no semester sheet row: %d" % orphans)

        con.commit()
        con.execute("PRAGMA integrity_check")
        con.close()
    except Exception:
        con.close()
        if os.path.exists(tmp):
            os.remove(tmp)
        raise

    os.chmod(tmp, 0o600)                 # student data: owner-only
    os.replace(tmp, out)                 # atomic - readers never see a half-written file
    print("\nwrote", out)


if __name__ == "__main__":
    try:
        main()
    except ImportError_ as e:
        sys.exit("IMPORT FAILED - database not replaced: %s" % e)
