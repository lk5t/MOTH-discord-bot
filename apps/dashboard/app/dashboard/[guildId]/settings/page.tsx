import { gate } from "@/lib/gate";
import { SettingsView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Server Settings" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "settings");
  return <SettingsView />;
}
