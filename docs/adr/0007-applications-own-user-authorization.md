---
status: accepted
---

# Applications own user authorization

whatsappd does not mint users, sessions, organizations, or account membership.
Applications authorize access through PocketBase rules, Convex wrappers,
Supabase RLS, or application-owned server routes, while account workers use a
separate privileged backend identity.
