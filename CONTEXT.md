# WhatsApp application substrate

This context describes the WhatsApp-native language shared by the live session,
durable mirror, backend adapters, clients, and UI bindings.

## Language

**WhatsApp Address**:
A protocol-native address for a WhatsApp participant, carrying one primary ID
and every known equivalent native ID, such as its PN and LID forms.
_Avoid_: Identity, contact, person

**Message Sender**:
The WhatsApp Address of the actual author of a message, including the linked
account for an own message.
_Avoid_: From, counterpart, chat
