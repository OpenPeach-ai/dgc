"""Bounded personal results, stored in the existing private run ledger."""
from .pip_chat import validate_text
from .workspace_registry import RegistryError


def validate(result):
    # A run that used its Pip computer reports how: browser calls made and writes it left held
    # for the user (each a separately approved action). It still performed no external action.
    if isinstance(result, dict) and 'computer' in result:
        computer = result['computer']
        if (not isinstance(computer, dict) or set(computer) != {'calls', 'held'} or type(computer['calls']) is not int
                or not 0 <= computer['calls'] <= 10000 or not isinstance(computer['held'], list) or len(computer['held']) > 8
                or not all(isinstance(a, str) and a.startswith('compact_') and len(a) <= 64 for a in computer['held'])):
            raise RegistryError('invalid_result', 'Invalid Pip computer usage in a personal result.')
    # Drafts are inert: commit_reply validates and saves each; the runner runs one only on a grant.
    drafts = {'message_draft', 'calendar_draft', 'connector_action_draft'}
    if (not isinstance(result, dict) or set(result)-{'snapshot', 'computer'}-drafts != {'text', 'external_actions', 'tools_called', 'usage'}
            or result.get('external_actions') is not False or type(result.get('tools_called')) is not int
            or result['tools_called'] != 0):
        raise RegistryError('invalid_result', 'A personal result must be text with no executed tools or external actions.')
    if 'snapshot' in result and result['snapshot'] != {'files':0,'bytes':0,'scope':'personal'}:
        raise RegistryError('invalid_result','Personal runs cannot contain a project snapshot.')
    validate_text(result['text'], reply=True)
    usage=result['usage']
    if (not isinstance(usage,dict) or set(usage)-{'input_tokens','output_tokens','cached_input_tokens','reasoning_tokens','requests'}
            or any(type(v) is not int or not 0<=v<2**53 for v in usage.values())):
        raise RegistryError('invalid_result','Invalid personal result usage counters.')
    return result
