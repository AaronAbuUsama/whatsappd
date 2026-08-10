export function WhatsAppAccountState({
  account,
  phase,
}: {
  readonly account: string;
  readonly phase: string;
}) {
  return (
    <box height={3} paddingX={1} justifyContent="space-between" alignItems="center">
      <text fg="#e9edef">
        <strong>whatsappd</strong> · {account}
      </text>
      <text fg={phase === "online" ? "#25d366" : "#f0b429"}>{phase}</text>
    </box>
  );
}
