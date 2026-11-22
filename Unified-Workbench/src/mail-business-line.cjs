// Read-only presentation normalization. Original role/businessLine evidence is preserved.
function mailBusinessLine(item){
 const value=String(item?.businessLine||'').trim().toLowerCase();
 if(['carseat','car-seat','car seat','汽车座椅套'].includes(value))return 'carseat';
 if(value==='furniture'||value==='furniture supplier')return 'furniture';
 if(['wool','knitwear','羊毛衫'].includes(value))return 'wool';
 if(value==='mmues')return 'mmues';
 const assessment=item?.customerReassessment;
 if(assessment?.decision==='可开发/可继续'&&assessment.sourceRefs?.some(source=>source.status==='captured')&&assessment.productLines?.some(line=>/家具|座椅|桌|椅|furniture|seating|table|chair|banquette/i.test(line)))return 'furniture';
 return 'unclassified';
}
module.exports={mailBusinessLine};
