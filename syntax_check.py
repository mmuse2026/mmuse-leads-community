"""Local syntax and optional Windows DNS MX checks."""
import re
import shutil
import subprocess
import json

def syntax(address):
    if not isinstance(address,str) or len(address)>254 or address.count('@')!=1:
        raise ValueError('未填写邮箱或地址格式无效。')
    local, domain=address.rsplit('@',1)
    if not 0<len(local)<=64 or not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+",local) or local.startswith('.') or local.endswith('.') or '..' in local:
        raise ValueError('邮箱用户名格式无效。')
    try:
        domain=domain.encode('idna').decode('ascii').lower()
    except UnicodeError as exc:
        raise ValueError('邮箱域名格式无效。') from exc
    labels=domain.split('.')
    if len(domain)>253 or len(labels)<2 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',label) for label in labels):
        raise ValueError('邮箱域名格式无效。')
    return domain

def lookup_mx(domain):
    # Restrict the interpolated payload again even when called independently.
    domain=syntax('lookup@'+domain)
    powershell=shutil.which('powershell.exe')
    if not powershell:
        return 'unsupported'
    command=("$ErrorActionPreference='Stop'; try { @("
        + f"Resolve-DnsName -Name '{domain}' -Type MX -DnsOnly -ErrorAction Stop"
        + " | ForEach-Object { $_.NameExchange } | Where-Object { $null -ne $_ }) | ConvertTo-Json -Compress } catch { exit 2 }")
    try:
        result=subprocess.run([powershell,'-NoProfile','-NonInteractive','-Command',command],
          text=True,capture_output=True,timeout=7,check=True)
        raw=json.loads(result.stdout.strip() or 'null')
        records=raw if isinstance(raw,list) else [raw] if isinstance(raw,str) else []
        if any(str(record).strip().rstrip('.') for record in records): return 'mx_found'
        if '.' in records: return 'null_mx'
        return 'mx_not_returned'
    except (OSError,subprocess.SubprocessError,ValueError):
        return 'dns_unknown'
