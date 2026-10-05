"""Bounded personal results, stored in the existing private run ledger."""
from .pip_chat import validate_text
from .workspace_registry import RegistryError


def validate(result):
    # Drafts are inert: commit_reply validates and saves each; the runner runs one only on a grant.
    drafts = {'message_draft', 'calendar_draft', 'connector_action_draft'}
    if (not isinstance(result, dict) or set(result)-{'snapshot'}-drafts != {'text', 'external_actions', 'tools_called', 'usage'}
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
