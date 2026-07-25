// peer.js — safe peer resolution for teleproto.
//
// Why this exists: teleproto's TL deserializer is strict. When you pass
// `peer: someStringOrNumber` to a raw `Api.messages.SendReaction({...})`
// call, it throws:
//
//   "Ambiguous type \"InputPeer\" — add \"_\" to pick a constructor"
//     (one of: InputPeerEmpty, InputPeerSelf, InputPeerChat,
//      InputPeerUser, InputPeerChannel, InputPeerUserFromMessage,
//      InputPeerChannelFromMessage)
//
// The fix is to resolve the chat id / @username / phone to a concrete
// `Api.InputPeerUser | InputPeerChat | InputPeerChannel | InputPeerSelf`
// before constructing the TL request. This module centralizes that.
//
// Every other module that needs to call `Api.*` should go through
// `resolveInputPeer(client, peer)` instead of passing strings directly.

'use strict';

// Module-level cache. Avoids re-resolving the same chat for every command.
// Teleproto's session cache already does this, but having an explicit
// short-TTL cache avoids the network round-trip on hot paths.
const _cache = new Map(); // key -> { peer, expiresAt }
const TTL_MS = 5 * 60 * 1000;

function _key(peer) {
  if (peer == null) return 'null';
  if (typeof peer === 'object') {
    if (peer.className?.startsWith('InputPeer')) {
      // Cache by userId/channelId
      if (peer.userId) return `user:${peer.userId}`;
      if (peer.chatId) return `chat:${peer.chatId}`;
      if (peer.channelId) return `channel:${peer.channelId}`;
    }
    if (peer.className === 'PeerUser' && peer.userId) return `user:${peer.userId}`;
    if (peer.className === 'PeerChat' && peer.chatId) return `chat:${peer.chatId}`;
    if (peer.className === 'PeerChannel' && peer.channelId) return `channel:${peer.channelId}`;
  }
  return String(peer);
}

function _isAlreadyInputPeer(peer) {
  return peer && typeof peer === 'object' && typeof peer.className === 'string'
    && peer.className.startsWith('InputPeer');
}

function _isAlreadyEntity(peer) {
  return peer && typeof peer === 'object' && (
    peer.className === 'User' ||
    peer.className === 'Chat' ||
    peer.className === 'Channel' ||
    peer.className === 'UserFull' ||
    peer.className === 'ChatFull' ||
    peer.className === 'ChannelFull'
  );
}

// Resolve any peer-like value (string id, @username, phone, number, entity,
// InputPeer) to a concrete `Api.TypeInputPeer`. Throws with a friendly
// message on failure.
async function resolveInputPeer(client, peer) {
  if (peer == null) throw new Error('resolveInputPeer: peer is null/undefined');
  if (_isAlreadyInputPeer(peer)) return peer;

  // Check cache
  const key = _key(peer);
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.peer;

  try {
    let resolved;
    if (_isAlreadyEntity(peer)) {
      // Entity (User/Chat/Channel) — call getInputPeer which can take entities
      resolved = await client.getInputPeer(peer);
    } else {
      // String/number/@username/phone — teleproto accepts all of these
      resolved = await client.getInputPeer(peer);
    }
    _cache.set(key, { peer: resolved, expiresAt: Date.now() + TTL_MS });
    return resolved;
  } catch (e) {
    // Clear any stale cache for this key
    _cache.delete(key);
    throw new Error(
      `could not resolve peer "${key}": ${e.message || e.errorMessage || e} — ` +
      `make sure the chat exists, you're a member, and the id/username is correct`
    );
  }
}

// Synchronous version for cases where the caller already has a full
// InputPeer (e.g. from a message we just received). Throws if not.
function asInputPeer(peer) {
  if (_isAlreadyInputPeer(peer)) return peer;
  throw new Error(`asInputPeer: expected InputPeer, got ${typeof peer} (${peer && peer.className})`);
}

// Extract a peer from a Message object. Messages always carry the full
// peer info because they're returned in their original chat context.
function peerFromMessage(msg) {
  if (!msg) return null;
  // teleproto Message objects have peerId for the chat the message belongs to
  if (msg.peerId) {
    if (msg.peerId.className === 'PeerUser') return { type: 'user', id: msg.peerId.userId };
    if (msg.peerId.className === 'PeerChat') return { type: 'chat', id: msg.peerId.chatId };
    if (msg.peerId.className === 'PeerChannel') return { type: 'channel', id: msg.peerId.channelId };
  }
  return null;
}

function clearCache() {
  _cache.clear();
}

module.exports = {
  resolveInputPeer,
  asInputPeer,
  peerFromMessage,
  clearCache,
  _isAlreadyInputPeer,
  _isAlreadyEntity,
};
