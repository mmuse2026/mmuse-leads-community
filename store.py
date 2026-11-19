"""Local lead records. This module never connects to the network."""
import csv
import io
import re
import sqlite3
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

STAGES = {'new': '待整理', 'qualified': '有意向', 'following': '跟进中', 'won': '已成交', 'closed': '已关闭'}
FIELDS = ('company', 'country', 'contact', 'website', 'email', 'stage', 'next_date', 'notes')
LIMITS = (160, 80, 100, 512, 256, 30, 10, 3000)
SCHEMA = """
CREATE TABLE IF NOT EXISTS leads (
 id INTEGER PRIMARY KEY, company TEXT NOT NULL, country TEXT NOT NULL DEFAULT '',
 contact TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT 'new',
 next_date TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
 domain TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_domain ON leads(domain) WHERE domain <> '';
CREATE UNIQUE INDEX IF NOT EXISTS lead_email ON leads(lower(email)) WHERE email <> '';
CREATE TABLE IF NOT EXISTS checks (
 lead_id INTEGER PRIMARY KEY REFERENCES leads(id), syntax_status TEXT NOT NULL,
 dns_status TEXT NOT NULL, checked_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS followups (
 id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id),
 occurred_on TEXT NOT NULL, note TEXT NOT NULL
);
"""

def connect(path, *, initialize=False):
    path = Path(path)
    if initialize:
        path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    if initialize:
        db.executescript(SCHEMA)
    return db

def normalize(fields):
    row = {name: (fields.get(name) or '').strip() for name in FIELDS}
    if not row['company']:
        raise ValueError('请填写公司名称。')
    if any(len(row[k]) > limit for k, limit in zip(FIELDS, LIMITS)):
        raise ValueError('填写内容超过字段长度限制。')
    row['stage'] = row['stage'] or 'new'
    if row['stage'] not in STAGES:
        raise ValueError('请选择有效阶段。')
    if row['next_date']:
        try:
            row['next_date'] = date.fromisoformat(row['next_date']).isoformat()
        except ValueError as exc:
            raise ValueError('跟进日期应为 YYYY-MM-DD。') from exc
    domain = ''
    if row['website']:
        try:
            url = urlsplit(row['website'] if '://' in row['website'] else 'https://' + row['website'])
            host = (url.hostname or '').lower().rstrip('.')
            if (url.scheme not in ('http', 'https') or url.username or url.password
                or not host or '.' not in host or any(c.isspace() for c in host)):
                raise ValueError
            domain = host.encode('idna').decode('ascii').removeprefix('www.')
        except (ValueError, UnicodeError) as exc:
            raise ValueError('请输入有效的网站，例如 example.com。') from exc
    row['domain'] = domain
    row['email'] = row['email'].lower()
    return row

def save(db, fields, lead_id=None):
    row = normalize(fields)
    try:
        if lead_id is None:
            cols = ','.join(row)
            args = ','.join(':'+k for k in row)
            return db.execute(f'INSERT INTO leads ({cols}) VALUES ({args})', row).lastrowid
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT email FROM leads WHERE id=?',(lead_id,)).fetchone()
        if previous and previous['email']!=row['email']:
            db.execute('DELETE FROM checks WHERE lead_id=?',(lead_id,))
        values = ','.join(k+'=:'+k for k in row)
        row['id'] = lead_id
        if not db.execute(f'UPDATE leads SET {values} WHERE id=:id', row).rowcount:
            raise ValueError('该客户不存在。')
        return lead_id
    except sqlite3.IntegrityError as exc:
        raise ValueError('网站域名或联系邮箱已在其他客户中登记。') from exc

def leads(db, query='', stage='', due=False):
    conditions = []
    params = []
    if query:
        conditions.append("(company LIKE ? ESCAPE '\\' OR country LIKE ? ESCAPE '\\' OR contact LIKE ? ESCAPE '\\' OR website LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')")
        escaped = query[:200].replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        params.extend(['%'+escaped+'%'] * 5)
    if stage:
        conditions.append('stage=?')
        params.append(stage)
    if due:
        conditions.append("next_date<>'' AND next_date<=? AND stage NOT IN ('won','closed')")
        params.append(date.today().isoformat())
    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    return db.execute("SELECT * FROM leads"+where+" ORDER BY next_date='' ASC,next_date ASC,id DESC", params)

def add_followup(db, lead_id, note):
    note = note.strip()
    if not note or len(note)>3000:
        raise ValueError('请填写跟进记录，最多 3000 字。')
    if not db.execute('SELECT 1 FROM leads WHERE id=?',(lead_id,)).fetchone():
        raise ValueError('该客户不存在。')
    db.execute('INSERT INTO followups(lead_id,occurred_on,note) VALUES(?,?,?)',(lead_id,date.today().isoformat(),note))

def import_csv(db, text):
    try:
        reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')), strict=True)
        if not reader.fieldnames or 'company' not in reader.fieldnames or set(reader.fieldnames)-set(FIELDS) or len(reader.fieldnames)!=len(set(reader.fieldnames)):
            raise ValueError('CSV 需要 company 列。其他字段请使用下载模板。')
        added = skipped = 0
        with db:
            for raw in reader:
                if None in raw:
                    raise ValueError(f'第 {reader.line_num} 行列数超过标题。')
                if not any(raw.values()):
                    continue
                try:
                    row = normalize(raw)
                except ValueError as exc:
                    raise ValueError(f'第 {reader.line_num} 行：{exc}') from exc
                match = db.execute("SELECT 1 FROM leads WHERE (?<>'' AND domain=?) OR (?<>'' AND lower(email)=?) OR (?='' AND ?='' AND lower(company)=lower(?) AND lower(country)=lower(?))",
                    (row['domain'],row['domain'],row['email'],row['email'],row['domain'],row['email'],row['company'],row['country'])).fetchone()
                if match:
                    skipped += 1
                    continue
                save(db,row)
                added += 1
        return added, skipped
    except csv.Error as exc:
        raise ValueError('CSV 无法读取，请检查列和引号。') from exc

def export_csv(rows):
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    writer.writerow(FIELDS)
    for row in rows:
        values = [row[k] for k in FIELDS]
        writer.writerow(["'"+v if v[:1] in ('=','+','-','@','\t','\r') else v for v in values])
    return '\ufeff'+output.getvalue()
