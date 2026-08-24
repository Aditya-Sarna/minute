import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("minute")
    .setDescription("Simple change in this playground — photo in the thread, PR for tech.")
    .addStringOption((o) =>
      o.setName("request").setDescription("What you want").setRequired(true),
    )
    .addAttachmentOption((o) =>
      o.setName("file").setDescription("Optional file to place in the repo"),
    ),
  new SlashCommandBuilder()
    .setName("minute-admin")
    .setDescription("Grant Minute access (admins only)")
    .addSubcommand((s) =>
      s
        .setName("allow")
        .setDescription("Let this person run /minute")
        .addUserOption((o) => o.setName("user").setDescription("Employee").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("revoke")
        .setDescription("Remove Minute access")
        .addUserOption((o) => o.setName("user").setDescription("Employee").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("who").setDescription("Show requesters, tech, playgrounds")),
].map((c) => c.toJSON());

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) {
  console.error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationCommands(clientId), { body: commands });
console.log("Registered /minute and /minute-admin");
