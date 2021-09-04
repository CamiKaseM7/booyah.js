const WebSocket = require("ws");
const { v1: uuidv1 } = require("uuid");
const apiv3 = require("../utils/RestAPI");
const EventEmiter = require("events");

function decodeBufferToJSON(buffer) {
	const json = buffer.toString("utf8");
	const jsonp = JSON.parse(json);
	return jsonp;
}

async function getUser(channel_id) {
	const json = await apiv3("GET", `channels/${channel_id}`);
	const user = { ...json.channel, ...json.user };
	return user;
}

class Connection {
	constructor(channel_id, parent) {
		this.channel_id = channel_id;
		this.parent = parent;
		this.headers = this.parent.headers;
		this.join();
	}

	sendMessage(message) {
		const json = { event: 0, data: { msg: message } };
		this.webSocket.send(JSON.stringify(json));
	}

	sendSticker(sticker_id) {
		const json = {
			event: 1,
			data: { sticker_id: sticker_id },
		};
		this.webSocket.send(JSON.stringify(json));
	}

	async getUpdatedChannelInfo() {
		const json = await apiv3(
			"GET",
			`channels/${this.channel_id}`,
			{},
			this.headers
		);

		if (json.message) throw new Error(json.message);
		this.channel = { ...json.channel, ...json.user };

		return this;
	}

	async getViewersCount() {
		const json = await apiv3(
			"GET",
			`chatrooms/${this.channel.chatroom_id}/audiences/count`,
			{},
			this.headers
		);
		return json.viewer_count;
	}

	async getAudience() {
		const viewers_count = await this.getViewersCount();
		const json = await apiv3(
			"GET",
			`chatrooms/${this.channel.chatroom_id}/audiences?cursor=0&count=${viewers_count}`,
			{ channel_id: this.channel_id },
			this.headers
		);
		const viewers = {
			audience: json.audience_list,
			viewer_count: viewers_count,
		};
		return viewers;
	}

	async punishUser(method, uid, nickname, type, reason) {
		const body = {
			nickname: nickname,
			source: 0,
			type: type,
			uid: uid,
			message: reason,
		};

		const response = await apiv3(
			method,
			`chatrooms/${this.channel.chatroom_id}/mutes`,
			body,
			this.headers
		);
		const error_code = response.code ? response.code : null;
		if (error_code == 403) {
			throw new Error("Forbidden, permission error");
		}
		return this;
	}

	muteUser(uid, nickname) {
		this.punishUser("POST", uid, nickname, 0);
		return this;
	}

	banUser(uid, nickname, reason) {
		this.punishUser("POST", uid, nickname, 1, reason);
		return this;
	}

	pardonUser(uid, nickname) {
		this.punishUser("DELETE", uid, nickname, 1);
		return this;
	}

	async join() {
		await this.getUpdatedChannelInfo();
		this.token = await this.parent.generateToken();

		const context = this.channel;

		const webSocket = new WebSocket(
			`wss://chat.booyah.live:9511/ws/v2/chat/conns?room_id=${this.channel.chatroom_id}&uid=${this.parent.user_id}&device_id=${this.parent.device_id}&token=${this.token}`
		);

		webSocket.on("open", () => {
			this.parent.emit("connected", context);

			setInterval(() => {
				console.log("Heartbeat");
				this.sendMessage("");
			}, 60 * 1000); //heartbeat every minute to prevent disconnection to the webSocket
		});

		webSocket.on("error", (error) => {
			console.log(`Error from ${this.channel_id}: ${error}`);
		});

		webSocket.on("close", () => {
			console.log(`Disconnected from ${this.channel_id}`);
		});

		webSocket.on("message", (buffer) => {
			const messages = decodeBufferToJSON(buffer);
			messages.forEach((message) => {
				const isOwner = message.data.badge_list.includes(201);

				const isModerator = message.data.badge_list.includes(202) || isOwner;

				const msg = {
					data: message.data,
					event: message.event,
					isModerator: isModerator,
					isOwner: isOwner,
				};

				const self = message.data.uid == this.parent.user_id;

				this.parent.emit("message", msg, context, this, self);
			});
		});

		this.webSocket = webSocket;
		return this;
	}
}

class Client extends EventEmiter {
	constructor(session_key, user_id) {
		super();
		this.session_key = session_key;
		this.user_id = user_id;
		this.headers = {
			"booyah-session-key": session_key,
			"x-csrf-token": session_key,
			"content-type": "application/json",
			cookie: `session_key=${session_key}`,
		};
		this.device_id = uuidv1();
		this.connections = {};
		this.testFunction();
	}

	sendMessage(channel, message) {
		if (typeof channel == String || typeof channel == Number) {
			const connection = this.connections[channel];
			if (!connection) throw new Error(`Not connected to channel ${channel}`);
			connection.sendMessage(message);
			return this;
		} else if (typeof channel == Connection) {
			channel.sendMessage(message);
			return this;
		}
		throw new Error("invalid channel");
	}

	sendSticker(channel, sticker_id) {
		if (typeof channel == String || typeof channel == Number) {
			const connection = this.connections[channel];
			if (!connection) throw new Error(`Not connected to channel ${channel}`);
			connection.sendSticker(sticker_id);
			return this;
		} else if (typeof channel == Connection) {
			channel.sendSticker(sticker_id);
			return this;
		}
		throw new Error("invalid channel");
	}

	async connectChannels(channels) {
		channels.forEach((channel) => {
			const connection = new Connection(channel, this);
			this.connections[channel] = connection;
			return connection;
		});
	}

	async generateToken() {
		const json = await apiv3(
			"POST",
			`users/${this.user_id}/chat-tokens`,
			{ device_id: this.device_id },
			this.headers,
			this.channel_id
		);
		const token = json.token;
		if (!token) throw new Error("Invalid session_id or user_id");
		return token;
	}
}

Booyah = {
	Client: Client,
	getUser: getUser,
};
module.exports = Client;