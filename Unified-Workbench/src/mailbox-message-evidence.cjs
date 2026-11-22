const crypto=require('node:crypto');
const cleanMailboxBody=value=>String(value).replace(/^(?:外部图片没有显示\n立即显示\nAlways display from this sender\n)/,'').trim();
const emails=text=>[...new Set((String(text).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).map(value=>value.toLowerCase()))];
function displayedDate(value){
  const match=String(value).match(/(?:周.|星期.)[,，]?\s*(\d{1,2})\s+(\d{1,2})月\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(上午|下午)?\s*([+-])(\d{2})(\d{2})/);
  if(!match)throw Error('SOURCE_DATE_UNCONFIRMED');
  let hour=Number(match[4]);if(match[7]==='下午'&&hour<12)hour+=12;if(match[7]==='上午'&&hour===12)hour=0;
  const month=Number(match[2]),day=Number(match[1]),minutes=Number(match[5]),seconds=Number(match[6]||0),offset=(Number(match[9])*60+Number(match[10]))*(match[8]==='+'?1:-1);
  if(month<1||month>12||day<1||day>31||hour>23||minutes>59||seconds>59||Math.abs(offset)>14*60)throw Error('SOURCE_DATE_INVALID');
  return new Date(Date.UTC(Number(match[3]),month-1,day,hour,minutes,seconds)-offset*60000).toISOString();
}
/** Interpret only an already-opened official message; never infer an address from body/signature text. */
function parseMailboxMessage(snapshot, account){
  const ACCOUNT=String(account||'').trim().toLowerCase();
  if(!ACCOUNT)throw Error('MAILBOX_ACCOUNT_NOT_CONFIGURED');
  if(snapshot?.ok!==true||snapshot.action!=='snapshot'||!snapshot.observedAt)throw Error('SOURCE_SNAPSHOT_REQUIRED');
  const result=snapshot.result||{},url=new URL(result.url||'about:blank');
  if(url.protocol!=='https:'||url.hostname!=='mail.zoho.com'||!url.pathname.startsWith('/zm/'))throw Error('SOURCE_OFFICIAL_MAIL_REQUIRED');
  const routeMessageId=url.hash.match(/\/p\/(\d{12,30})(?:$|[/?])/i)?.[1];
  const visibleRows=Array.isArray(result.messages)?result.messages.filter(row=>String(row?.id||'').match(/^\d{12,30}$/)):[];
  const messageId=routeMessageId|| (visibleRows.length===1?String(visibleRows[0].id):null);
  if(!messageId)throw Error(visibleRows.length>1?'SOURCE_MESSAGE_ID_AMBIGUOUS':'SOURCE_OPEN_MESSAGE_REQUIRED');
  if(visibleRows.length&&visibleRows.filter(row=>String(row.id)===messageId).length!==1)throw Error('SOURCE_MESSAGE_ID_AMBIGUOUS');
  const text=String(result.text||'').replace(/\r\n/g,'\n'),marker='\n永久链接\n',start=text.indexOf(marker);
  if(start<0)throw Error('SOURCE_MESSAGE_HEADER_NOT_FOUND');
  const lines=text.slice(start+marker.length).split('\n');while(lines.length&&/^(暂缓处理|Snooze|\s*)$/.test(lines[0]))lines.shift();
  const dateIndex=lines.findIndex((line,index)=>index>0&&index<12&&/\d{4}.*[+-]\d{4}\s*$/.test(line));if(dateIndex<2)throw Error('SOURCE_MESSAGE_HEADER_INCOMPLETE');
  const subject=lines[0].trim(),senders=emails(lines.slice(1,dateIndex).join('\n'));if(!subject||senders.length!==1)throw Error('SOURCE_EXACT_SENDER_UNCONFIRMED');
  const toIndex=lines.findIndex((line,index)=>index>dateIndex&&index<dateIndex+8&&/^(到|To)$/.test(line.trim()));
  const tagsIndex=lines.findIndex((line,index)=>index>toIndex&&index<toIndex+12&&/^(标签|Tags)$/.test(line.trim()));
  if(toIndex<0||tagsIndex<0)throw Error('SOURCE_RECIPIENT_HEADER_UNCONFIRMED');
  const recipients=emails(lines.slice(toIndex+1,tagsIndex).join('\n'));if(!recipients.length)throw Error('SOURCE_EXACT_RECIPIENT_UNCONFIRMED');
  const direction=senders[0]===ACCOUNT?'outbound':recipients.includes(ACCOUNT)?'inbound':null;if(!direction)throw Error('SOURCE_ACCOUNT_MISMATCH');
  let bodyLines=lines.slice(tagsIndex+1),bodyStart=-1;
  for(let index=0;index<Math.min(12,bodyLines.length);index++)if(/^正在读取\s*\d+\s*\/\s*\d+$/.test(bodyLines[index].trim())||/^翻译$/.test(bodyLines[index].trim())){bodyStart=index+1;break}
  // Plain-text mail may have no translation/loading control. Its security block is explicit.
  if(bodyStart<0){const tls=bodyLines.findIndex((line,index)=>index>0&&index<6&&/^TLS了解更多$/.test(line.trim())&&bodyLines[index-1].trim()==='安全');if(tls>=0&&bodyLines[tls+1]?.trim()==='')bodyStart=tls+2}
  if(bodyStart<0)throw Error('SOURCE_BODY_BOUNDARY_UNCONFIRMED');
  const region=bodyLines.slice(bodyStart).join('\n'),endMarkers=region.match(/\n回复\n回复所有人\n转发/g)||[];
  if(endMarkers.length!==1)throw Error('SOURCE_BODY_END_AMBIGUOUS');
  const body=cleanMailboxBody(region.slice(0,region.indexOf('\n回复\n回复所有人\n转发')));if(!body||body.length>100000)throw Error('SOURCE_BODY_INVALID');
  return {version:1,mailboxMessageId:messageId,sourceRequestId:snapshot.requestId,source:'bbox_official_rendered_message',account:ACCOUNT,direction,fromEmail:senders[0],toEmails:recipients,subject,body,displayedDate:lines[dateIndex],date:displayedDate(lines[dateIndex]),dateBasis:'official_mailbox_displayed_offset',observedAt:snapshot.observedAt,bodySha256:crypto.createHash('sha256').update(body).digest('hex'),classification:'unclassified',approvalStatus:'not_approved'};
}
module.exports={parseMailboxMessage,displayedDate,cleanMailboxBody};
