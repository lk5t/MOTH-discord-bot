import { gate } from "@/lib/gate";
import { SetupView } from "./view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Quick Setup" };

export default async function Page({ params }: { params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  await gate(guildId, "setup");
  return <SetupView />;
}
