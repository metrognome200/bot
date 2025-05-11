const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const moment = require('moment');
const TelegramBot = require('node-telegram-bot-api');

// Store active bot instances and running scripts
const activeBots = {};
const runningScripts = {};
const userConfigs = {};

// PiggyBasket configuration
const PIGGY_CONFIG = {
    url: 'https://plankton-app-p3psz.ondigitalocean.app/shot',
    headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'app-source': 'main',
        'content-type': 'application/json',
        'origin': 'https://app-master.piggybasket.io',
        'priority': 'u=1, i',
        'referer': 'https://app-master.piggybasket.io/',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Microsoft Edge";v="134"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'cross-site',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
    },
    defaultData: { goal: true, bet: "x1" }
};

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

// Helper function to write analysis
async function writeAnalysis(responseData) {
    const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
    const analysisText = `[${timestamp}] Response: ${JSON.stringify(responseData)}\n`;
    await fs.promises.appendFile('analysis.txt', analysisText);
}

// Helper function to write responses
async function writeResponse(responseData) {
    await fs.promises.appendFile('responses.txt', JSON.stringify(responseData) + '\n');
}

// Function to run the PiggyBasket script
async function runPiggyScript(bot, chatId, scriptId, telegramData) {
    let requestCounter = 0;
    let isRunning = true;
    runningScripts[scriptId] = { isRunning };

    try {
        while (isRunning) {
            try {
                const response = await axios.post(PIGGY_CONFIG.url, PIGGY_CONFIG.defaultData, {
                    headers: { ...PIGGY_CONFIG.headers, 'telegram-data': telegramData }
                });

                requestCounter++;
                const responseData = response.data;

                // Log every 10 requests
                if (requestCounter % 10 === 0) {
                    const statusMessage = `Requests sent: ${requestCounter} | Last Response: ${JSON.stringify(responseData)}`;
                    console.log(statusMessage);
                    await bot.sendMessage(chatId, statusMessage);
                }

                // Write to files
                await writeResponse(responseData);
                await writeAnalysis(responseData);

                // Check for NO_ENERGY error
                if (responseData && responseData.ok === false && responseData.errorCode === "NO_ENERGY") {
                    await bot.sendMessage(chatId, "NO_ENERGY detected, stopping script.");
                    isRunning = false;
                    break;
                }

                // Check if script should continue
                if (!runningScripts[scriptId] || !runningScripts[scriptId].isRunning) {
                    isRunning = false;
                    break;
                }

                // Wait before next request
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error("Request error:", error.message);
                await bot.sendMessage(chatId, `Error in request: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait longer on error
            }
        }
    } catch (error) {
        console.error("Script error:", error);
        await bot.sendMessage(chatId, `Script stopped due to error: ${error.message}`);
    } finally {
        delete runningScripts[scriptId];
    }
}

// Bot setup endpoint
app.post('/set-config', async (req, res) => {
    const { botToken, userId, telegramData } = req.body;
    
    if (!botToken || !userId) {
        return res.json({ ok: false, message: 'Both Bot Token and User ID are required.' });
    }

    try {
        // Store user config
        userConfigs[userId] = { botToken, telegramData };
        
        // Initialize or update bot
        if (!activeBots[userId]) {
            const bot = new TelegramBot(botToken, { polling: true });
            
            // Setup bot commands
            bot.onText(/\/start/, async (msg) => {
                if (msg.chat.id.toString() !== userId) return;
                await bot.sendMessage(msg.chat.id, 'Welcome! Use /run to start the script and /stop to stop it.');
            });

            bot.onText(/\/run/, async (msg) => {
                if (msg.chat.id.toString() !== userId) return;
                const scriptId = `script_${userId}`;
                if (runningScripts[scriptId]) {
                    await bot.sendMessage(msg.chat.id, 'Script is already running!');
                    return;
                }
                const userConfig = userConfigs[userId];
                if (!userConfig.telegramData) {
                    await bot.sendMessage(msg.chat.id, 'Please set telegram-data first using the web interface.');
                    return;
                }
                runPiggyScript(bot, msg.chat.id, scriptId, userConfig.telegramData);
                await bot.sendMessage(msg.chat.id, 'Script started!');
            });

            bot.onText(/\/stop/, async (msg) => {
                if (msg.chat.id.toString() !== userId) return;
                const scriptId = `script_${userId}`;
                if (runningScripts[scriptId]) {
                    runningScripts[scriptId].isRunning = false;
                    await bot.sendMessage(msg.chat.id, 'Stopping script...');
                } else {
                    await bot.sendMessage(msg.chat.id, 'No script is currently running.');
                }
            });

            activeBots[userId] = bot;
        }

        res.json({ ok: true, message: 'Bot configured and started.' });
    } catch (error) {
        res.json({ ok: false, message: 'Failed to start bot: ' + error.message });
    }
});

// Update telegram-data endpoint
app.post('/update-data', (req, res) => {
    const { userId, telegramData } = req.body;
    if (!userId || !telegramData) {
        return res.status(400).json({ ok: false, message: 'User ID and telegram-data are required.' });
    }

    if (userConfigs[userId]) {
        userConfigs[userId].telegramData = telegramData;
        res.json({ ok: true, message: 'Telegram data updated successfully.' });
    } else {
        res.status(404).json({ ok: false, message: 'User configuration not found.' });
    }
});

// Get status endpoint
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const scriptId = `script_${userId}`;
    const isRunning = runningScripts[scriptId]?.isRunning || false;
    const userConfig = userConfigs[userId];

    res.json({
        ok: true,
        isRunning,
        hasConfig: !!userConfig,
        hasTelegramData: !!userConfig?.telegramData
    });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));