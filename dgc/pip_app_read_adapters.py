"""Closed additional Composio reads. Public tool metadata checked 2026-10-04.

Search only; no downloads, pagination, arbitrary actions or account defaults.
Provider metadata is not permission. Every call needs the existing saved review.
"""
from __future__ import annotations
import unicodedata
from .workspace_registry import RegistryError

DRIVE='GOOGLEDRIVE_FIND_FILE'
NOTION='NOTION_SEARCH_NOTION_PAGE'
CONTACTS='GOOGLECONTACTS_SEARCH_CONTACTS'
TOOLS=frozenset({DRIVE,NOTION,CONTACTS})
DRIVE_FIELDS='files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken,incompleteSearch'
DESCRIPTORS={
 DRIVE:{'toolkit':'googledrive','label':'Google Drive','query':'q','limit':'pageSize',
        'example':{'q':"trashed = false and name contains 'Budget'",'pageSize':5,'fields':DRIVE_FIELDS,'spaces':'drive','corpora':'user','supportsAllDrives':False,'includeItemsFromAllDrives':False},
        'notice':'Search file names and return IDs, names, types, edit dates and links. No file contents or downloads.'},
 NOTION:{'toolkit':'notion','label':'Notion','query':'query','limit':'page_size',
         'example':{'query':'Reading','page_size':5,'filter_value':'page','filter_property':'object'},
         'notice':'Search page titles and return IDs, titles, edit dates and links. No page bodies. Recently shared pages may not be indexed yet.'},
 CONTACTS:{'toolkit':'googlecontacts','label':'Google Contacts','query':'query','limit':'page_size',
           'example':{'query':'Alex','page_size':5,'sources':['CONTACT'],'read_mask':'names,emailAddresses'},
           'notice':'Search saved contacts. Only names and email addresses go to the model; no phone numbers or addresses.'}}


def validate(tool,args):
    spec=DESCRIPTORS[tool];expected=spec['example']
    if not isinstance(args,dict) or set(args)!=set(expected):
        raise RegistryError('invalid_app_arguments','Review the exact supported search fields. Downloads, pagination and unlisted fields are not permitted.')
    query=args[spec['query']];limit=args[spec['limit']]
    if (not isinstance(query,str) or not query or query!=query.strip() or len(query.encode())>1024
            or any(unicodedata.category(c).startswith('C') for c in query)):
        raise RegistryError('invalid_app_arguments','Review a nonempty search query up to 1,024 bytes without invisible controls.')
    if type(limit) is not int or not 1<=limit<=20:
        raise RegistryError('invalid_app_arguments','Review an explicit search limit of 1–20 items.')
    for key,value in expected.items():
        if key in (spec['query'],spec['limit']):continue
        if type(args[key]) is not type(value) or args[key]!=value:
            raise RegistryError('invalid_app_arguments','This search has fixed reviewed data fields. Broader scope needs a supported adapter, not an extra flag.')
    return args


def schema_supported(tool,schema):
    if not isinstance(schema,dict) or schema.get('type')!='object':return False
    fields=DESCRIPTORS[tool]['example'];required=schema.get('required',[])
    if not isinstance(required,list) or any(not isinstance(k,str) or k not in fields for k in required):return False
    props=schema.get('properties',{})
    if not isinstance(props,dict):return False
    for k,value in fields.items():
        kind='boolean' if type(value) is bool else 'integer' if type(value) is int else 'array' if isinstance(value,list) else 'string'
        if not isinstance(props.get(k),dict) or props[k].get('type')!=kind:return False
        if kind=='array' and (not isinstance(props[k].get('items'),dict) or props[k]['items'].get('type')!='string'):return False
    return True


def project(tool,data,args):
    """Keep only the reviewed reference fields; never forward provider guidance."""
    def fail():raise RegistryError('app_read_failed','The app returned an unsupported search result. No result was passed to the model.')
    if not isinstance(data,dict):fail()
    rows=data.get('files' if tool==DRIVE else 'results')
    if not isinstance(rows,list) or len(rows)>args[DESCRIPTORS[tool]['limit']]:fail()
    def text(value,maximum=2048):
        if not isinstance(value,str) or len(value.encode())>maximum:fail()
        return value
    result=[]
    for row in rows:
        if not isinstance(row,dict):fail()
        if tool==DRIVE:
            result.append({'id':text(row.get('id'),256),'name':text(row.get('name')),
                **{k:text(row[k]) for k in ('mimeType','modifiedTime','webViewLink') if row.get(k) is not None}})
        elif tool==NOTION:
            if row.get('object')!='page' or not isinstance(row.get('properties'),dict):fail()
            titles=[]
            for value in row['properties'].values():
                if not isinstance(value,dict):fail()
                if value.get('type')=='title':
                    parts=value.get('title')
                    if not isinstance(parts,list) or len(parts)>100:fail()
                    for part in parts:
                        if not isinstance(part,dict):fail()
                        titles.append(text(part.get('plain_text')))
            title=text(''.join(titles))
            result.append({'id':text(row.get('id'),256),'title':title,
                **{k:text(row[k]) for k in ('url','last_edited_time') if row.get(k) is not None}})
        else:
            person=row.get('person')
            if not isinstance(person,dict):fail()
            out={'id':text(person.get('resourceName'),256),'names':[],'email_addresses':[]}
            for key,field,target in (('names','displayName','names'),('emailAddresses','value','email_addresses')):
                values=person.get(key,[])
                if not isinstance(values,list) or len(values)>20:fail()
                for v in values:
                    if not isinstance(v,dict):fail()
                    out[target].append(text(v.get(field),512))
            result.append(out)
    if tool==NOTION:
        more=data.get('has_more')
        if type(more) is not bool:fail()
    else:
        token=data.get('nextPageToken')
        if token is not None:text(token)
        more=bool(token)
    if 'incompleteSearch' in data and type(data['incompleteSearch']) is not bool:fail()
    return {'items':result,'has_more':bool(more),'incomplete_search':data.get('incompleteSearch') is True,
            'notice':'Only this bounded search page was read. No pagination or linked content was followed.'}
