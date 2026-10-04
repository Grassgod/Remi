import { describe, expect, it } from 'bun:test';
import { resolveWake, type WakeContext } from '@multiremi/store/inbox/wake-policy.js';
import type { MessageKind, MessageRecipient, MessageSenderType, MessageWake, WakeReason } from '@multiremi/contracts/unified-model.js';
const base:WakeContext={recipientType:'agent',recipientId:'target',recipientAvailable:true,sourceHasIssue:true,targetHasIssue:true};
const rows:[string,MessageSenderType,MessageKind,MessageRecipient,Partial<WakeContext>,MessageWake,WakeReason][]=[
  ['human','member','request',{type:'agent',ref:'target'},{},'now','human_sender'],
  ['platform owner','platform','status',{type:'role',ref:'issue_owner'},{},'now','platform_to_owner'],
  ['timer owner','timer','request',{type:'role',ref:'issue_owner'},{},'now','platform_to_owner'],
  ['unrelated agents dispatch','agent','request',{type:'agent',ref:'target'},{},'now','agent_dispatch'],
  ['delegator reply','agent','reply',{type:'agent',ref:'target'},{isReplyToDelegator:true},'now','member_to_delegator'],
  ['leader','agent','report',{type:'role',ref:'leader'},{},'now','to_leader'],
  ['parent owner','agent','report',{type:'role',ref:'parent_owner'},{},'now','to_parent_owner'],
  ['other agent report','agent','report',{type:'agent',ref:'target'},{},'next_turn','agent_pair_not_privileged'],
  ['pair boundary 9','agent','request',{type:'agent',ref:'target'},{pairHops:9,pairLimit:5},'now','agent_dispatch'],
  ['pair boundary 10','agent','request',{type:'agent',ref:'target'},{pairHops:10,pairLimit:5},'next_turn','pair_round_trip_limit'],
  ['self','agent','request',{type:'agent',ref:'sender'},{recipientId:'sender'},'inbox_only','self'],
  ['archived','member','request',{type:'agent',ref:'target'},{recipientAvailable:false},'inbox_only','recipient_unavailable'],
  ['dependencies','member','request',{type:'agent',ref:'target'},{dependenciesMet:false},'next_turn','dependencies_unmet'],
  ['side session','agent','request',{type:'agent',ref:'target'},{sourceSideSession:true},'next_turn','source_side_session'],
  ['no source issue','agent','request',{type:'agent',ref:'target'},{sourceHasIssue:false},'next_turn','no_issue_target'],
  ['no target issue','agent','request',{type:'agent',ref:'target'},{targetHasIssue:false},'next_turn','no_issue_target'],
  ['human inbox','agent','decision',{type:'member',ref:'target'},{recipientType:'member'},'now','platform_to_owner'],
  ['ordinary statement','agent','reply',{type:'none'},{recipientType:'none'},'inbox_only','no_recipient'],
];
describe('MUL-506 wake policy',()=>{
  for(const [name,type,kind,to,ctx,applied,reason] of rows)it(name,()=>expect(resolveWake({type,id:'sender'},to,'now',kind,{...base,...ctx})).toEqual({applied,reason}));
  for(const requested of ['next_turn','inbox_only'] as const)it(`explicit ${requested}`,()=>expect(resolveWake({type:'member',id:'sender'},{type:'agent',ref:'target'},requested,'request',base)).toEqual({applied:requested,reason:requested==='next_turn'?'requested_next_turn':'requested_inbox_only'}));
});
