import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { ServerPicker } from "./picker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Servers" };

export default async function Dashboard() {
  const s = await getSession();
  if (!s) redirect("/");
  return <ServerPicker user={s.user} />;
}
