# Discord Bot Setup & Permissions Guide

## Required Discord Bot Permissions

### Step 1: Create Bot Application

1. Go to https://discord.com/developers/applications
2. Click **"New Application"**
3. Give it a name (e.g., "Polymarket Bot" or "Polymarket Bot Test")
4. Click **"Create"**

### Step 2: Enable Required Intents (IMPORTANT!)

1. Go to the **"Bot"** section in the left sidebar
2. Scroll down to **"Privileged Gateway Intents"**
3. Enable the following intents:
   - **MESSAGE CONTENT INTENT** (Required - this is a privileged intent)
   - **SERVER MEMBERS INTENT** (Optional, but recommended)

**Why MESSAGE CONTENT INTENT is required:**

- The bot needs to read message content to respond to commands like `!start`, `!buy`, `!balance`, etc.
- Without this intent, the bot cannot see what users type in messages

### Step 3: Get Bot Token

1. Still in the **"Bot"** section
2. Under **"Token"**, click **"Reset Token"** or **"Copy"**
3. **Save this token** - you'll need it for your `.env` file
4. **Never share this token publicly!**

### Step 4: Set Bot Permissions

When inviting the bot to your server, you need these permissions:

#### Required Permissions:

- **Send Messages** - Bot needs to send responses to commands
- **Read Message History** - Bot needs to read commands in channels
- **View Channels** - Bot needs to see channels
- **Embed Links** - Bot sends rich embeds for balance, paper trading, etc.
- **Use External Emojis** - Bot uses emojis in messages (optional but recommended)

#### Optional Permissions (for better UX):

- **Add Reactions** - For interactive features (if you add them later)
- **Attach Files** - If you want to send files/logs (optional)

### Step 5: Invite Bot to Server

1. Go to the **"OAuth2"** → **"URL Generator"** section
2. Under **"Scopes"**, select:
   - **bot**
   - **applications.commands** (optional, for slash commands if you add them later)
3. Under **"Bot Permissions"**, select the permissions listed above
4. Copy the generated URL at the bottom
5. Open the URL in your browser
6. Select your server and click **"Authorize"**

**Or use this direct invite URL (replace YOUR_CLIENT_ID):**

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2048&scope=bot
```

**Minimum permissions number:** `2048` (Send Messages + Read Message History + View Channels + Embed Links)

**Recommended permissions number:** `277025508352` (includes all recommended permissions)

### Step 6: Verify Bot Permissions in Server

1. Go to your Discord server
2. Right-click your server → **"Server Settings"** → **"Roles"**
3. Find your bot's role (should be named after your bot)
4. Verify the permissions are set correctly

## Quick Permission Checklist

- [ ] Bot application created
- [ ] **MESSAGE CONTENT INTENT** enabled (in Bot settings)
- [ ] Bot token copied and saved
- [ ] Bot invited to server with correct permissions
- [ ] Bot role has permissions in server settings
- [ ] Bot token added to `.env` file as `DISCORD_TOKEN`

## Troubleshooting

### Bot doesn't respond to commands

**Possible causes:**

1. **MESSAGE CONTENT INTENT not enabled** - Go to Discord Developer Portal → Bot → Enable "MESSAGE CONTENT INTENT"
2. **Bot doesn't have "Read Message History" permission** - Check server role permissions
3. **Bot token incorrect** - Verify token in `.env` file matches the one in Developer Portal
4. **Bot not in the channel** - Make sure bot has access to the channel

### Bot can't send messages

**Possible causes:**

1. **Missing "Send Messages" permission** - Check server role permissions
2. **Channel permissions** - Check if bot role is allowed in that specific channel
3. **Bot rate limited** - Wait a few seconds and try again

### Bot can't see message content

**This is the most common issue!**

- **Solution:** Enable **MESSAGE CONTENT INTENT** in Discord Developer Portal
- Go to: https://discord.com/developers/applications → Your Bot → Bot → Privileged Gateway Intents → Enable "MESSAGE CONTENT INTENT"
- You may need to wait a few minutes for the change to take effect

## Code Reference

The bot uses these Discord.js intents (defined in `index.js`):

```javascript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, // Server/guild information
    GatewayIntentBits.GuildMessages, // Server messages
    GatewayIntentBits.MessageContent, // Message content (PRIVILEGED INTENT)
  ],
  partials: [Partials.Channel], // Partial channel data
});
```

## Security Notes

- **Never commit your bot token to git** - It's in `.gitignore` for a reason
- **Don't share your bot token** - Anyone with it can control your bot
- **Use different tokens for test and production** - Create separate bot applications
- **Regenerate token if compromised** - Go to Bot settings → Reset Token

## For Testing

When setting up a test bot, follow the same steps but:

1. Create a **separate bot application** (e.g., "Polymarket Bot Test")
2. Use a **different Discord server** or channel for testing
3. Use the test bot token in your `.env.test` file
