"""Launch the offline community edition with Python 3.10 or newer."""
import argparse
from contextlib import closing
from html import escape
from email.parser import BytesParser
from email.policy import default
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import secrets
from urllib.parse import parse_qs, urlencode, urlsplit
import webbrowser

from syntax_check import lookup_mx, syntax
from store import FIELDS, LIMITS, STAGES, add_followup, connect, export_csv, import_csv, leads, save

CSS = '''
:root{font:15px system-ui,"Microsoft YaHei",sans-serif;color:#273249;background:#f4f6fa}
*{box-sizing:border-box}body{margin:0}.head{background:#202e49;color:white;padding:18px 5vw;display:flex;align-items:center;justify-content:space-between;gap:18px}
.head a{color:white;text-decoration:none}.head small{color:#c1cce1}main{max-width:1120px;margin:auto;padding:34px 5vw}
h1{font-size:28px;margin:0 0 5px}h2{font-size:19px;margin:0 0 14px}p{color:#54627a}.card{background:white;border:1px solid #e0e5ee;border-radius:15px;padding:22px;margin:18px 0}
form,.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}label{display:grid;gap:6px;flex:1 1 210px}input,select,textarea,button,.button{font:inherit;min-height:40px;border:1px solid #c4ccdb;border-radius:8px;padding:8px 11px;background:white;color:inherit}textarea{resize:vertical;min-height:85px}.wide{flex-basis:100%}
button,.button{background:#3855a3;color:white;border-color:#3855a3;text-decoration:none;cursor:pointer;display:inline-block}.secondary{background:white;color:#3855a3;border-color:#c4ccdb}
a{color:#3855a3}.notice,.error{padding:13px;border-radius:9px;background:#e5f2ec}.error{background:#ffe8e5}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid #e5e9ef;white-space:nowrap}th{color:#54627a}.history{white-space:pre-wrap}
:focus-visible{outline:2px solid #3855a3;outline-offset:2px}
'''
CHECK_MESSAGES = {'valid':'邮箱格式通过','invalid':'邮箱格式不通过',
    'not_checked':'尚未查询域名','mx_found':'发现域名 MX 记录',
    'null_mx':'域名声明不接收邮件','dns_unknown':'DNS 查询未得出结果',
    'mx_not_returned':'本次未返回 MX 记录','unsupported':'当前系统不支持内置 DNS 查询'}
LABELS={'company':'公司名称','country':'国家或地区','contact':'联系人','website':'网站','email':'联系邮箱','stage':'阶段','next_date':'下次跟进','notes':'备注'}
E=lambda value: escape(str(value), quote=True)

def options(selected):
    return ''.join(f'<option value="{key}"'+(' selected' if selected==key else '')+f'>{name}</option>' for key,name in STAGES.items())

def page(title, details, error='', notice=''):
    alert = f'<div class="error" role="alert">{E(error)}</div>' if error else ''
    info = f'<div class="notice" role="status">{E(notice)}</div>' if notice else ''
    return f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{E(title)} · MMUSE</title><style>{CSS}</style><header class="head"><a href="/"><strong>MMUSE · 获客管理</strong></a><small>社区版 · 本地资料</small></header><main>{alert}{info}{details}</main></html>'

def lead_form(row, token):
    mode='编辑客户' if row.get('id') else '新建客户'
    target='/edit?id='+str(row['id']) if row.get('id') else '/new'
    controls=[]
    for name,limit in zip(FIELDS,LIMITS):
        val=E(row.get(name,''))
        if name=='stage': field=f'<select name="stage">{options(row.get(name))}</select>'
        elif name=='notes': field=f'<textarea name="notes" maxlength="{limit}">{val}</textarea>'
        else:
            kind='date' if name=='next_date' else 'text'
            required=' required' if name=='company' else ''
            field=f'<input type="{kind}" name="{name}" value="{val}" maxlength="{limit}"{required}>'
        tag=' class="wide"' if name=='notes' else ''
        controls.append(f'<label{tag}>{LABELS[name]}{field}</label>')
    return f'<section class="card"><h1>{mode}</h1><p><a href="/">返回客户列表</a></p><form method="post" action="{target}"><input type="hidden" name="token" value="{token}">{"".join(controls)}<button>保存客户</button></form></section>'

class Handler(BaseHTTPRequestHandler):
    timeout = 12

    def log_message(self,*args):
        return

    def respond(self, content, status=200, content_type='text/html; charset=utf-8', filename=None):
        data=content.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',content_type)
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
        if filename:
            self.send_header('Content-Disposition',f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def request_parts(self):
        parsed=urlsplit(self.path)
        return parsed.path, {key: values[-1] for key,values in parse_qs(parsed.query, max_num_fields=12).items()}

    def local(self):
        if self.headers.get('Host')!=self.server.host_header:
            self.respond('仅限从本机启动地址打开。',403)
            return False
        return True

    def redirect(self, target, **params):
        self.send_response(303)
        self.send_header('Location', target + ('?' + urlencode(params) if params else ''))
        self.end_headers()

    def listing(self, db, query):
        text=query.get('q','')
        stage=query.get('stage','')
        due=query.get('due')=='1'
        records=list(leads(db,text,stage,due))
        rows=''.join('<tr><td><a href="/edit?id='+str(row['id'])+'">'+E(row['company'])+'</a></td>'+
            ''.join(f'<td>{E(value or "—")}</td>' for value in (row['country'],row['contact'],STAGES[row['stage']],row['next_date']))+'</tr>' for row in records)
        results=(f'<div class="table-wrap"><table><thead><tr><th>公司</th><th>国家</th><th>联系人</th><th>阶段</th><th>下次跟进</th></tr></thead><tbody>{rows}</tbody></table></div>' if rows
                 else '<p>没有匹配的客户。可以新建客户或导入 CSV。</p>')
        return f'''<h1>客户列表</h1><p>当前显示 {len(records)} 条记录</p>
        <div class="actions"><a class="button" href="/new">新建客户</a><a class="button secondary" href="/import">导入 CSV</a><a class="button secondary" href="/export?{E(urlencode({'q':text,'stage':stage,'due':int(due)}))}">导出当前列表</a></div>
        <section class="card"><form method="get" action="/"><label>搜索<input name="q" value="{E(text)}" placeholder="公司、国家、联系人、网站或邮箱" maxlength="200"></label><label>阶段<select name="stage"><option value="">全部</option>{options(stage)}</select></label><label>跟进<select name="due"><option value="0">全部</option><option value="1"{' selected' if due else ''}>今天及已到期</option></select></label><button>筛选</button><a href="/">清空</a></form>{results}</section>'''

    def imports(self, text=''):
        return f'''<section class="card"><h1>导入客户 CSV</h1><p>需包含 company 列。按网站或联系邮箱跳过重复项，导入不会覆盖已有资料。<a href="/template">下载空白 CSV 模板</a></p>
        <form method="post" action="/import" enctype="multipart/form-data"><input type="hidden" name="token" value="{self.server.token}"><label>选择 UTF-8 CSV 文件<input type="file" name="file" accept=".csv,text/csv"></label><label class="wide">也可以粘贴带标题的 CSV 内容<textarea name="csv" rows="8">{E(text)}</textarea></label><button>导入</button><a href="/">取消</a></form></section>'''

    def do_GET(self):
        if not self.local(): return
        try:
            route,query=self.request_parts()
            with closing(connect(self.server.db_path)) as db:
                if route=='/':
                    self.respond(page('客户列表',self.listing(db,query),notice=query.get('notice','')))
                elif route=='/new':
                    self.respond(page('新建客户',lead_form({},self.server.token)))
                elif route=='/edit':
                    identity=int(query.get('id','0'))
                    row=db.execute('SELECT * FROM leads WHERE id=?',(identity,)).fetchone()
                    if not row:
                        self.respond(page('客户未找到','<a href="/">返回客户列表</a>'),404)
                        return
                    history=''.join(f'<p class="history"><strong>{E(log["occurred_on"])}</strong>　{E(log["note"])}</p>' for log in db.execute('SELECT * FROM followups WHERE lead_id=? ORDER BY id DESC',(identity,)))
                    follow=f'''<section class="card"><h2>跟进记录</h2>{history or '<p>暂无记录</p>'}<form method="post" action="/followup?id={identity}"><input type="hidden" name="token" value="{self.server.token}"><label class="wide">记录本次跟进<textarea name="note" required maxlength="3000"></textarea></label><button>添加记录</button></form></section>'''
                    check=db.execute('SELECT * FROM checks WHERE lead_id=?',(identity,)).fetchone()
                    result=(CHECK_MESSAGES[check['syntax_status']]+' · '+CHECK_MESSAGES[check['dns_status']] if check else '尚未检查')
                    panel=f'''<section class="card"><h2>邮箱检查</h2><p>{E(result)}。域名记录无法确认具体邮箱是否可送达。</p><form method="post" action="/check?id={identity}"><input type="hidden" name="token" value="{self.server.token}"><button name="mode" value="syntax">检查地址格式</button><button name="mode" value="mx" class="secondary">查询域名 MX</button></form></section>'''
                    self.respond(page('客户详情',lead_form(dict(row),self.server.token)+panel+follow,notice=query.get('notice','')))
                elif route=='/import':
                    self.respond(page('导入客户',self.imports()))
                elif route in ('/export','/template'):
                    rows=[] if route=='/template' else leads(db,query.get('q',''),query.get('stage',''),query.get('due')=='1')
                    self.respond(export_csv(rows),content_type='text/csv; charset=utf-8',filename='leads.csv')
                else:
                    self.respond(page('页面未找到','<a href="/">返回客户列表</a>'),404)
        except ValueError:
            self.respond(page('请求无效','<a href="/">返回客户列表</a>'),400)
        except (OSError, sqlite3.Error):
            self.respond(page('无法读取资料','<a href="/">返回客户列表</a>'),503)

    def post_fields(self, body, route):
        kind=self.headers.get_content_type()
        if kind=='application/x-www-form-urlencoded':
            return {k:v[-1] for k,v in parse_qs(body.decode('utf-8'),keep_blank_values=True,max_num_fields=20).items()}
        if kind=='multipart/form-data' and route=='/import':
            boundary=self.headers.get_param('boundary')
            if not boundary or not all(ord(c)>=32 and ord(c)<127 for c in boundary):
                raise ValueError('上传格式无效。')
            message=BytesParser(policy=default).parsebytes(
                b'Content-Type: multipart/form-data; boundary="'+boundary.encode('ascii')+b'"\r\n\r\n'+body)
            if not message.is_multipart():
                raise ValueError('上传格式无效。')
            fields={}
            for part in message.iter_parts():
                name=part.get_param('name',header='content-disposition')
                if name not in ('csv','file','token') or name in fields or part.is_multipart():
                    raise ValueError('上传字段不支持。')
                fields[name]=part.get_payload(decode=True).decode('utf-8-sig')
            return fields
        raise ValueError('请求格式不支持。')

    def do_POST(self):
        if not self.local(): return
        origin=self.headers.get('Origin')
        if origin and origin!='http://'+self.server.host_header:
            self.respond('请求来源不匹配。',403)
            return
        route=''
        fields={}
        try:
            route,query=self.request_parts()
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=2_000_000:
                self.respond('请求格式不支持或内容过大。',413)
                return
            fields=self.post_fields(self.rfile.read(size),route)
            if not secrets.compare_digest(fields.get('token','').encode(),self.server.token.encode()):
                self.respond('会话已更新，请刷新页面。',403)
                return
            with closing(connect(self.server.db_path)) as db:
                if route in ('/new','/edit'):
                    identity=int(query.get('id','0')) if route=='/edit' else None
                    with db:
                        key=save(db,fields,identity)
                    self.redirect('/edit',id=key,notice='客户已保存。')
                elif route=='/followup':
                    identity=int(query.get('id','0'))
                    with db:
                        add_followup(db,identity,fields.get('note',''))
                    self.redirect('/edit',id=identity,notice='跟进已记录。')
                elif route=='/check':
                    identity=int(query.get('id','0'))
                    current=db.execute('SELECT email FROM leads WHERE id=?',(identity,)).fetchone()
                    if not current:
                        raise ValueError('该客户不存在。')
                    dns_status='not_checked'
                    try:
                        domain=syntax(current['email'])
                        syntax_status='valid'
                        if fields.get('mode')=='mx':
                            dns_status=lookup_mx(domain)
                    except ValueError:
                        syntax_status='invalid'
                    with db:
                        updated=db.execute("""
                            INSERT INTO checks (lead_id,syntax_status,dns_status,checked_on)
                            SELECT id,?,?,date('now','localtime') FROM leads WHERE id=? AND email=?
                            ON CONFLICT(lead_id) DO UPDATE SET syntax_status=excluded.syntax_status,
                                dns_status=CASE WHEN excluded.dns_status='not_checked' THEN checks.dns_status
                                                ELSE excluded.dns_status END,
                                checked_on=excluded.checked_on
                            """,(syntax_status,dns_status,identity,current['email']))
                        if not updated.rowcount:
                            raise ValueError('检查期间邮箱已更新，请刷新后重试。')
                    self.redirect('/edit',id=identity,notice='检查已记录。')
                elif route=='/import':
                    text=fields.get('file','') or fields.get('csv','')
                    if not text.strip():
                        raise ValueError('请选择 CSV 文件或粘贴 CSV 内容。')
                    added,skipped=import_csv(db,text)
                    self.redirect('/',notice=f'新增 {added} 条；跳过重复 {skipped} 条。')
                else:
                    self.respond('页面未找到。',404)
        except sqlite3.Error:
            self.respond(page('无法保存资料','<a href="/">返回客户列表</a>'),503)
        except ValueError as exc:
            if route in ('/new','/edit'):
                identity=query.get('id','')
                if route=='/edit' and identity.isdecimal(): fields['id']=int(identity)
                details=lead_form(fields,self.server.token)
            elif route=='/import':
                details=self.imports(fields.get('csv',''))
            else:
                details='<a href="/">返回客户列表</a>'
            self.respond(page('处理失败',details,error=str(exc)),400)

def create_server(db_path, port=0):
    with closing(connect(db_path, initialize=True)): pass
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    server.db_path=db_path
    server.host_header=f'127.0.0.1:{server.server_port}'
    server.token=secrets.token_urlsafe(32)
    return server

def main():
    cli=argparse.ArgumentParser(description='MMUSE 获客管理社区版')
    cli.add_argument('--port',type=int,default=0)
    cli.add_argument('--data-dir',type=Path,default=Path(os.environ.get('LOCALAPPDATA') or Path.home()/'.local'/'share')/'MMUSE Leads Community')
    cli.add_argument('--no-browser',action='store_true')
    args=cli.parse_args()
    with create_server(args.data_dir/'leads.sqlite3',args.port) as server:
        url='http://'+server.host_header+'/'
        print(url,flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass

if __name__=='__main__':
    main()
