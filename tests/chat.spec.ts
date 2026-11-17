import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { PlanView, RecordView, StudyWeekStats, TemplatePlanState } from '../src/lib/contracts'
import type { Card, ChatInput, ChatReply, MessageView } from '../src/features/chat/types'

// All /v1 requests are protocol fixtures; these tests never invoke a model.
test('对话卡片、输入法、范围、撤销与丢回复核对', async ({ page }) => {
  const id=randomUUID(), planId=randomUUID(), recId=randomUUID()
  const plan: PlanView={id:planId,kind:'ledger',name:'日常记账',activity:null,status:'active',startDate:'2026-11-16',hidden:[],order:[],lastActivityAt:new Date().toISOString()}
  const record: RecordView={id:recId,planId,kind:'expense',amountCents:2000,minutes:null,category:'餐饮',date:'2026-11-16',note:'午饭',refundOf:null,refundedCents:0,source:'chat',sourceMessageId:null,version:1,deleted:false,createdAt:new Date().toISOString()}
  const ledger={month:'2026-11',spendCents:2000,refundCents:0,netCents:2000,budgetCents:300000,remainingCents:298000,usagePct:.7,overCents:0}
  const study: StudyWeekStats={week:'2026-11-16',daysPerWeek:5,minMinutes:20,goalComplete:true,targetDays:5,metDays:1,exceededDays:0,recordDays:1,totalMinutes:20,interrupted:false,days:[{date:'2026-11-16',minutes:20,sessions:1,status:'met'}]}
  const planCard={plan,ledger}
  const category: { category: '餐饮'; spendCents: number; refundCents: number; netCents: number }={category:'餐饮',spendCents:2000,refundCents:0,netCents:2000}
  const cards: Card[]=[
  {type:'receipt',operationId:randomUUID(),kind:'batch',undoable:false,items:[{type:'expense_added',record}]},
  {type:'plan',card:planCard,note:'从这里开始。'},
  {type:'query',kind:'ledger_month',plan,from:'2026-11-01',to:'2026-11-16',...ledger,byCategory:[category],focus:'summary',category:null},
  {type:'query',kind:'ledger_range',plan,from:'2026-11-01',to:'2026-11-16',spendCents:2000,refundCents:0,netCents:2000,byCategory:[category],category:null,label:'本月',keywords:['午饭'],count:1},
  {type:'query',kind:'study_week',plan:{...plan,kind:'study',name:'阅读'},stats:study,label:'本周',today:'2026-11-16'},
  {type:'query',kind:'study_range',plan:{...plan,kind:'study',name:'阅读'},from:'2026-11-01',to:'2026-11-16',label:'最近',totalMinutes:20,recordDays:1},
  {type:'query',kind:'comparison',plan,metric:'net',unit:'CNY_cents',category:null,current:{from:'2026-11-01',to:'2026-11-16',label:'本月',value:2000},previous:{from:'2026-10-01',to:'2026-10-31',label:'上月',value:1000},delta:1000,changePct:100},
  {type:'query',kind:'overview',plans:[planCard],label:'进行中的计划'},
  {type:'query',kind:'none',message:'没有找到这个区间的记录。'},
  {type:'clarify',pendingId:randomUUID(),question:'要记录到哪个计划？',items:[{summary:'学习20分钟',ready:false,issue:'请选择计划'}],options:[{id:'reading',label:'阅读',style:'primary'},{id:'cancel',label:'取消',style:'cancel'}],hint:'选一个计划后继续。',status:'open'},
  {type:'error',code:'model_unavailable',message:'暂时无法理解，请稍后再试。',retryable:true},
  {type:'notice',tone:'info',text:'可以在计划中修改记录。'},
  {type:'future_card',message:'must not show raw JSON'} as unknown as Card]
  let history: MessageView[]=[{id:randomUUID(),role:'assistant',text:'这些是协议渲染测试数据。',cards,scopePlanId:null,clientMsgId:null,createdAt:new Date().toISOString()}]
  const posts: (ChatInput & { clientMsgId: string })[]=[], ops: { clientOpId: string }[]=[], lookups: string[]=[]
  let lastReply: ChatReply | null=null, mode='normal', aiConsent=true
  await page.setViewportSize({width:1440,height:1000})
  const errors: string[]=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/v1/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname
   const send=(data: unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
   if(path==='/v1/auth/web/session')return send({userId:id,csrfToken:'contract-test-csrf'})
   if(path==='/v1/me')return send({id,aiConsent,dataVersion:1,today:'2026-11-16',timezone:'Asia/Shanghai',signInMethod:'email'})
   if(path==='/v1/plans')return send({plans:[planCard],dataVersion:1})
   if(path==='/v1/messages')return send({messages:history})
   if(path==='/v1/chat' && req.method()==='POST'){
    const body=req.postDataJSON() as ChatInput & { clientMsgId: string };posts.push(body)
    expect(req.headers()['x-planplan-expected-user']).toBe(id)
    expect(req.headers()['x-csrf-token']).toBe('contract-test-csrf')
    const user: MessageView={id:randomUUID(),role:'user',text:body.text,cards:[],scopePlanId:body.scopePlanId??null,clientMsgId:body.clientMsgId,createdAt:new Date().toISOString()}
    const assistant: MessageView={id:randomUUID(),role:'assistant',text:'记好了。',cards:[{type:'receipt',operationId:randomUUID(),kind:'batch',undoable:true,items:[{type:'expense_added',record}]}],scopePlanId:body.scopePlanId??null,clientMsgId:null,createdAt:new Date().toISOString()}
    history=[...history,user,assistant];lastReply={user,assistant,dataVersion:2,transient:false}
    if(mode==='drop')return route.abort('failed')
    return send(lastReply)
   }
   if(path.startsWith('/v1/chat/')){ lookups.push(path.split('/').at(-1)!); return send({status:'succeeded',result:lastReply}) }
   if(path.includes('/undo')){
    const body=req.postDataJSON() as { clientOpId: string };ops.push(body)
    for(const message of history)for(const card of message.cards)if(card.type==='receipt')card.undoable=false
    return send({operationId:randomUUID(),clientOpId:body.clientOpId,kind:'undo',items:[{type:'undone',of:'earlier',records:[{...record,deleted:true}],plans:[plan]}],dataVersion:3,createdAt:new Date().toISOString(),undoable:false})
   }
   return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'not_found',message:'test path unsupported'}})})
  })
  await page.goto('/chat?plan='+planId)
  await expect(page).toHaveTitle('对话 · PlanPlan')
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  await expect(page.locator('.message-card')).toHaveCount(13)
  await expect(page.getByText('这条内容暂时无法完整显示。',{exact:false})).toBeVisible()
  await expect(page.getByText('must not show raw JSON')).toHaveCount(0)
  await expect(page.locator('.chat-scope')).toContainText('日常记账')
  const input=page.getByRole('textbox',{name:'消息',exact:true})
  await input.fill('午饭20元')
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  expect(posts.length).toBe(0)
  await input.dispatchEvent('compositionend')
  await input.press('Shift+Enter')
  expect(posts.length).toBe(0)
  await input.press('Enter')
  await expect.poll(()=>posts.length).toBe(1)
  await expect(input).toHaveValue('')
  expect(posts[0].scopePlanId).toBe(planId)
  expect(posts[0].text).toBe('午饭20元')
  await page.getByRole('button',{name:'撤销这次操作',exact:true}).click()
  await page.getByRole('button',{name:'确认撤销',exact:true}).click()
  await expect.poll(()=>ops.length).toBe(1)
  await expect(page.getByRole('button',{name:'撤销这次操作',exact:true})).toHaveCount(0)
  mode='drop'
  await input.fill('恢复测试20元')
  await page.getByRole('button',{name:'发送消息',exact:true}).click()
  await expect.poll(()=>posts.length).toBe(2)
  await expect(input).toHaveValue('恢复测试20元')
  await page.getByRole('button',{name:'核对结果',exact:true}).click()
  await expect(input).toHaveValue('')
  expect(lookups).toEqual([posts[1].clientMsgId])
  expect(posts).toHaveLength(2)
  await page.getByRole('button',{name:'清除计划范围'}).click()
  await expect(page.locator('.chat-scope')).toHaveCount(0)
  await page.setViewportSize({width:390,height:844})
  await page.locator('.chat-scroll-end').scrollIntoViewIfNeeded()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  const positions = await page.evaluate(() => ({ last: document.querySelector('.message-history')!.getBoundingClientRect().bottom, composer: document.querySelector('.composer-region')!.getBoundingClientRect().top }))
  expect(positions.last).toBeLessThanOrEqual(positions.composer + 1)
  await page.setViewportSize({width:1440,height:1000})
  await page.locator('.chat-scroll-end').scrollIntoViewIfNeeded()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  aiConsent=false
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('link',{name:'查看 AI 服务说明',exact:true})).toBeVisible()
  await expect(page.getByRole('button',{name:'取消',exact:true})).toBeDisabled()
  await expect(page.getByRole('button',{name:'撤销这次操作',exact:true})).toBeEnabled()
  expect(errors).toEqual([])
})

test('阅读范围显示明确书籍来源，发送与历史使用同一计划，未授权仍有手动入口', async ({ page }) => {
  const userId = randomUUID(), planId = randomUUID(), otherId = randomUUID(), recordId = randomUUID()
  const plan: PlanView = { id: planId, kind: 'study', name: '我的阅读', activity: '阅读', status: 'active', startDate: '2026-11-16', hidden: [], order: [], lastActivityAt: new Date().toISOString() }
  const template = {
    planId, templateId: 'official.reading', templateVersion: 1, source: 'official', engine: 'study',
    config: { version: 1, setupStatus: 'pending', name: plan.name, startDate: plan.startDate, currentBook: '置身事内', daysPerWeek: null, minMinutes: null, goalEffectiveFrom: { daysPerWeek: null, minMinutes: null } },
  } as TemplatePlanState
  let aiConsent = true
  const history: MessageView[] = [{ id: randomUUID(), role: 'assistant', text: '另一个计划的历史', cards: [], scopePlanId: otherId, clientMsgId: null, createdAt: new Date().toISOString() }]
  const posts: (ChatInput & { clientMsgId: string })[] = [], historyScopes: (string | null)[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/v1/auth/web/session') return route.fulfill({ json: { userId, csrfToken: 'reading-fixture' } })
    if (url.pathname === '/v1/me') return route.fulfill({ json: { id: userId, aiConsent, dataVersion: 1, today: '2026-11-16', timezone: 'Asia/Shanghai', signInMethod: 'email' } })
    if (url.pathname === '/v1/plans') return route.fulfill({ json: { plans: [{ plan }, { plan: { ...plan, id: otherId, name: '专业阅读' } }], dataVersion: 1 } })
    if (url.pathname === `/v1/plans/${planId}/template`) return route.fulfill({ json: template })
    if (url.pathname === `/v1/plans/${otherId}/template`) return route.fulfill({ json: { ...template, planId: otherId, config: { ...template.config, currentBook: '另一本书' } } })
    if (url.pathname === '/v1/messages') {
      const scope = url.searchParams.get('scopePlanId')
      historyScopes.push(scope)
      return route.fulfill({ json: { messages: scope ? history.filter(message => message.scopePlanId === scope) : history } })
    }
    if (url.pathname === '/v1/chat' && request.method() === 'POST') {
      expect(request.headers()['x-planplan-capabilities']).toContain('reading-template-v1')
      const body = request.postDataJSON() as ChatInput & { clientMsgId: string }
      posts.push(body)
      const user: MessageView = { id: randomUUID(), role: 'user', text: body.text, cards: [], scopePlanId: body.scopePlanId ?? null, clientMsgId: body.clientMsgId, createdAt: new Date().toISOString() }
      const assistant: MessageView = { ...user, id: randomUUID(), role: 'assistant', text: '记好了。', clientMsgId: null, cards: [{ type: 'receipt', operationId: randomUUID(), kind: 'batch', undoable: false, items: [{ type: 'study_added', record: { id: recordId, planId, kind: 'study', minutes: 25, amountCents: null, category: null, date: '2026-11-16', note: '书名：《置身事内》\n阅读位置：第35页', refundOf: null, refundedCents: null, source: 'chat', sourceMessageId: user.id, version: 1, deleted: false, createdAt: user.createdAt } }] }] }
      history.push(user, assistant)
      return route.fulfill({ json: { user, assistant, dataVersion: 2, transient: false } })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: '没有该测试接口。' } } })
  })
  await page.goto(`/chat?plan=${planId}`)
  await expect(page.getByRole('heading', { name: '我的阅读', exact: true })).toBeVisible()
  await expect(page.getByText('当前书籍：《置身事内》（来自计划设置）', { exact: true })).toBeVisible()
  await expect(page.getByText('另一个计划的历史', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '记录一次阅读', exact: true }).click()
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  expect(posts).toHaveLength(0)
  await expect(input).toHaveValue('今天读了 25 分钟')
  await input.fill('今天读了25分钟，读到第35页')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(posts[0].scopePlanId).toBe(planId)
  await expect(page.locator('.receipt-record-main')).toContainText('阅读位置：第35页')
  await expect(page.locator('.receipt-record-main')).toHaveAttribute('href', `/plans/${planId}?record=${recordId}`)
  await page.reload()
  await expect(page.locator('.receipt-record-main')).toContainText('25 分钟')
  expect(historyScopes.every(scope => scope === planId)).toBe(true)
  await page.goto(`/chat?plan=${otherId}`)
  await expect(page.getByText('另一个计划的历史', { exact: true })).toBeVisible()
  await expect(page.locator('.receipt-record-main')).toHaveCount(0)
  await expect(page.getByText('当前书籍：《另一本书》（来自计划设置）', { exact: true })).toBeVisible()
  aiConsent = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await input.fill('今天读了25分钟')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await expect(page.getByRole('link', { name: '手动记录', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})

test('通用模板对话按定义显示记录与统计，整批澄清可取消且不展示字段代码', async ({ page }) => {
  const userId=randomUUID(),planId=randomUUID(),recordId=randomUUID(),operationId=randomUUID(),pendingId=randomUUID()
  const plan:PlanView={id:planId,kind:'generic',name:'我的容量记录',activity:null,status:'active',startDate:'2026-11-16',hidden:[],order:['summary','records'],lastActivityAt:new Date().toISOString()}
  // A second, differently named definition verifies that rendering is not keyed to official.water.
  const definition={id:'official.capacity-fixture',version:1,schemaVersion:1,name:'容量采样',engine:'generic',source:'official',description:'记录容量',requiredCapabilities:['generic-record-v1'],configurationFields:[],recordFields:[{id:'date',label:'日期',type:'date',required:true},{id:'volume',label:'本次数量',type:'integer',required:true,unit:'ml',min:1,max:100000}],metrics:[{id:'total',label:'今天总量',operation:'sum',fieldId:'volume',period:'day'}],components:['summary','records'],example:{config:{},record:{date:'2026-11-16',volume:100}}}
  const template={planId,templateId:definition.id,templateVersion:1,source:'official',engine:'generic',definition,config:{version:1,setupStatus:'ready',name:plan.name,startDate:plan.startDate,values:{target:2000}}} as unknown as TemplatePlanState
  const record:RecordView={id:recordId,planId,kind:'generic',fields:{date:'2026-11-16',volume:300},definitionVersion:1,amountCents:null,minutes:null,category:null,date:'2026-11-16',note:'午后',refundOf:null,refundedCents:0,source:'chat',sourceMessageId:null,version:1,deleted:false,createdAt:new Date().toISOString()}
  const summary={planId,from:'2026-11-16',to:'2026-11-16',recordCount:2,metrics:[{id:'total',label:'今天总量',operation:'sum' as const,fieldId:'volume',unit:'ml',value:800,target:null,remaining:null,progressPct:null},{id:'goal',label:'今日目标进度',operation:'goal_progress' as const,fieldId:'volume',unit:'ml',value:800,target:2000,remaining:1200,progressPct:40}]}
  const cards:Card[]=[{type:'receipt',operationId,kind:'batch',undoable:true,items:[{type:'generic_added',record,generic:summary}]},{type:'query',kind:'generic_period',plan,summary},{type:'plan',card:{plan,generic:summary},note:'目标与实际记录分别保存。'},{type:'receipt',operationId:randomUUID(),kind:'batch',undoable:false,items:[{type:'record_edited',before:record,record:{...record,fields:{...record.fields,volume:500},version:2},generic:summary}]},{type:'clarify',pendingId,question:'每杯是多少ml？',items:[{summary:'午饭18元',ready:true,issue:null},{summary:'阅读25分钟',ready:true,issue:null},{summary:'两杯',ready:false,issue:'缺少本次容量'}],options:[{id:'cancel',label:'取消这3条',style:'cancel'}],hint:'这3条都还没有保存，补充后会一起保存。',status:'open'}]
  let history:MessageView[]=[{id:randomUUID(),role:'assistant',text:'已记录的内容如下。',cards,scopePlanId:planId,clientMsgId:null,createdAt:new Date().toISOString()}]
  const posts:ChatInput[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/v1/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname
    const send=(data:unknown)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)})
    if(path==='/v1/auth/web/session')return send({userId,csrfToken:'generic-chat-fixture'})
    if(path==='/v1/me')return send({id:userId,aiConsent:true,dataVersion:1,today:'2026-11-16',timezone:'Asia/Shanghai',signInMethod:'email'})
    if(path==='/v1/plans')return send({plans:[{plan,generic:summary}],dataVersion:1})
    if(path===`/v1/plans/${planId}/template`)return send(template)
    if(path==='/v1/messages'){expect(url.searchParams.get('scopePlanId')).toBe(planId);return send({messages:history})}
    if(path==='/v1/chat'&&request.method()==='POST'){
      const body=request.postDataJSON();posts.push(body);expect(request.headers()['x-planplan-capabilities']).toContain('generic-record-v1');expect(body).toMatchObject({scopePlanId:planId,pendingId,choice:'cancel'})
      cards.forEach(card=>{if(card.type==='clarify')card.status='cancelled'})
      const user:MessageView={id:randomUUID(),role:'user',text:body.text,cards:[],scopePlanId:planId,clientMsgId:body.clientMsgId,createdAt:new Date().toISOString()}
      const assistant:MessageView={...user,id:randomUUID(),role:'assistant',text:'这3条已取消，没有保存。',clientMsgId:null}
      history=[...history,user,assistant];return send({user,assistant,dataVersion:1,transient:false})
    }
    return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:{code:'not_found',message:'不存在'}})})
  })
  await page.setViewportSize({width:1440,height:1000});await page.goto(`/chat?plan=${planId}`)
  await expect(page.getByText('本次数量：300 ml',{exact:true}).first()).toBeVisible()
  await expect(page.getByText('本次数量：500 ml',{exact:true})).toBeVisible()
  await expect(page.locator('.message-history')).toContainText('今天总量800 ml')
  await expect(page.locator('.message-history')).toContainText('目标 2,000 ml · 还差 1,200 ml · 40%')
  await expect(page.locator('.message-history')).not.toContainText('amountMl')
  await expect(page.locator('.message-history')).not.toContainText('volume')
  await expect(page.locator('.message-history')).not.toContainText('undefined')
  await expect(page.getByRole('link',{name:/午后.*本次数量：300 ml/}).first()).toHaveAttribute('href',`/plans/${planId}?record=${recordId}`)
  await page.getByRole('button',{name:'撤销这次操作',exact:true}).click();await expect(page.getByText('确认撤销这批操作？只撤回本批改动，后来独立保存的记录仍然保留。')).toBeVisible();await page.getByRole('button',{name:'保留',exact:true}).click()
  await page.getByRole('button',{name:'取消这3条',exact:true}).click();await expect.poll(()=>posts.length).toBe(1);await expect(page.getByText('这3条已取消，没有保存。',{exact:true})).toBeVisible()
  await page.reload();await expect(page.getByText('本次数量：500 ml',{exact:true})).toBeVisible();expect(posts).toHaveLength(1)
  await page.setViewportSize({width:390,height:844});await page.locator('.chat-scroll-end').scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  await page.screenshot({path:'/tmp/planplan-generic-chat-mobile.png',fullPage:true});expect(errors).toEqual([])
})

test('对话超时后跨30和60秒仍在处理：保留原输入，只核对同ID，成功后显示唯一三类批次', async ({ page }) => {
  const userId = randomUUID(), operationId = randomUUID(), genericPlanId = randomUUID()
  const today = '2026-11-16', text = '午饭18元，阅读25分钟，喝水300ml'
  const posts: (ChatInput & { clientMsgId: string })[] = [], lookups: string[] = [], errors: string[] = []
  let ready = false, batches = 0, reply: ChatReply | null = null
  const baseRecord: RecordView = { id: randomUUID(), planId: randomUUID(), kind: 'expense', amountCents: 1800, minutes: null, category: '餐饮', date: today, note: '午饭', refundOf: null, refundedCents: 0, source: 'chat', sourceMessageId: null, version: 1, deleted: false, createdAt: new Date().toISOString() }
  const records: RecordView[] = [baseRecord, { ...baseRecord, id: randomUUID(), planId: randomUUID(), kind: 'study', amountCents: null, category: null, minutes: 25, note: '阅读' }, { ...baseRecord, id: randomUUID(), planId: genericPlanId, kind: 'generic', amountCents: null, category: null, note: '喝水', definitionVersion: 1, fields: { date: today, volume: 300 } }]
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => {
    if (!['warning', 'error'].includes(message.type())) return
    if (message.location().url.endsWith('/v1/chat') && /ERR_TIMED_OUT|timed out|Load failed/i.test(message.text())) return // Deliberate network-timeout fixture.
    errors.push(message.text())
  })
  // Advance the recovery age without waiting a real minute or spending model quota.
  await page.clock.install({ time: new Date(`${today}T12:00:00+08:00`) })
  await page.route('**/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const send = (json: unknown) => route.fulfill({ json })
    if (path === '/v1/auth/web/session') return send({ userId, csrfToken: 'processing-fixture' })
    if (path === '/v1/me') return send({ id: userId, aiConsent: true, dataVersion: batches, today, timezone: 'Asia/Shanghai', signInMethod: 'email' })
    if (path === '/v1/messages') return send({ messages: reply ? [reply.user, reply.assistant] : [] })
    if (path === `/v1/plans/${genericPlanId}/template`) return send({ definition: { version: 1, recordFields: [{ id: 'volume', label: '本次数量', unit: 'ml' }] } })
    if (path === '/v1/chat' && request.method() === 'POST') {
      expect(request.headers()['x-planplan-capabilities']).toContain('chat-recovery-v1')
      expect(request.headers()['x-planplan-expected-user']).toBe(userId)
      posts.push(request.postDataJSON())
      return route.abort('timedout')
    }
    if (path.startsWith('/v1/chat/') && request.method() === 'GET') {
      lookups.push(path.split('/').at(-1)!)
      expect(request.headers()['x-planplan-expected-user']).toBe(userId)
      expect(lookups.at(-1)).toBe(posts[0]!.clientMsgId)
      if (!ready) return send({ status: 'processing' })
      if (!reply) {
        batches++
        const user: MessageView = { id: randomUUID(), role: 'user', text, cards: [], scopePlanId: null, clientMsgId: posts[0]!.clientMsgId, createdAt: new Date().toISOString() }
        const assistant: MessageView = { ...user, id: randomUUID(), role: 'assistant', text: '这三条已一起保存。', clientMsgId: null, cards: [{ type: 'receipt', operationId, kind: 'batch', undoable: false, items: [{ type: 'expense_added', record: records[0]! }, { type: 'study_added', record: records[1]! }, { type: 'generic_added', record: records[2]! }] }] }
        reply = { user, assistant, dataVersion: batches, transient: false }
      }
      return send({ status: 'succeeded', result: reply })
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'fixture route missing' } } })
  })
  const pending = () => page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('planplan-recovery', 1)
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    try {
      return await new Promise<{ id: string; body: { text: string }; createdAt: number } | null>((resolve, reject) => {
        const request = db.transaction('pending').objectStore('pending').get(id)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  }, userId)
  await page.goto('/chat')
  const input = page.getByRole('textbox', { name: '消息', exact: true })
  await input.fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeVisible()
  const original = await pending()
  expect(original).toMatchObject({ id: posts[0]!.clientMsgId, body: { text } })
  for (const [index, button] of ['核对结果', '重试原消息'].entries()) {
    await page.clock.fastForward(31_000)
    expect(await page.evaluate(() => Date.now()) - original!.createdAt).toBeGreaterThanOrEqual((index + 1) * 31_000)
    await page.getByRole('button', { name: button, exact: true }).click()
    await expect(page.getByText('仍在处理中，请稍后再核对。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '核对结果', exact: true })).toBeEnabled()
    await expect(input).toHaveValue(text)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
    expect(await pending()).toEqual(original)
    expect(posts).toHaveLength(1)
    expect(batches).toBe(0)
  }
  ready = true
  await page.getByRole('button', { name: '核对结果', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对结果', exact: true })).toHaveCount(0)
  await expect(input).toHaveValue('')
  await expect(page.getByText('这三条已一起保存。', { exact: true })).toBeVisible()
  await expect(page.locator('.receipt-record')).toHaveCount(3)
  await expect(page.locator('.message-card')).toHaveCount(1)
  await expect(page.getByText('本次数量：300 ml', { exact: true })).toBeVisible()
  expect(await pending()).toBeNull()
  expect(lookups).toEqual(Array(3).fill(posts[0]!.clientMsgId))
  expect(posts).toHaveLength(1)
  expect(batches).toBe(1)
  await page.reload()
  await expect(page.locator('.receipt-record')).toHaveCount(3)
  await expect(page.locator('.message-card')).toHaveCount(1)
  expect(posts).toHaveLength(1)
  expect(batches).toBe(1)
  expect(errors).toEqual([])
})

test('聊天历史使用服务器游标，同时间消息可继续读取，末页停止', async ({ page }) => {
  const id = randomUUID(), messages: MessageView[] = Array.from({ length: 57 }, (_, i) => ({ id: randomUUID(), role: 'assistant', text: `同时间合成消息${i}`, cards: [], scopePlanId: null, clientMsgId: null, createdAt: '2026-11-17T04:00:00.123Z' }))
  const cursors: (string | null)[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url())
    const send = (json: unknown) => route.fulfill({ json })
    if (url.pathname === '/v1/auth/web/session') return send({ userId: id, csrfToken: 'cursor-fixture' })
    if (url.pathname === '/v1/me') return send({ id, aiConsent: false, dataVersion: 1, today: '2026-11-17', timezone: 'Asia/Shanghai', signInMethod: 'email' })
    if (url.pathname === '/v1/messages') {
      expect(url.searchParams.has('before')).toBe(false)
      const cursor = url.searchParams.get('cursor'); cursors.push(cursor)
      expect(cursor === null || cursor === 'opaque-server-cursor').toBe(true)
      return send(cursor ? { messages: messages.slice(0, 7), nextCursor: null } : { messages: messages.slice(7), nextCursor: 'opaque-server-cursor' })
    }
    return send({ plans: [] })
  })
  await page.goto('/chat')
  await expect(page.locator('.chat-message')).toHaveCount(50)
  await page.getByRole('button', { name: '查看更早的对话' }).click()
  await expect(page.locator('.chat-message')).toHaveCount(57)
  await expect(page.getByRole('button', { name: '查看更早的对话' })).toHaveCount(0)
  expect(cursors[0]).toBeNull(); expect(cursors.filter(value => value !== null)).toEqual(['opaque-server-cursor']); expect(errors).toEqual([])
})
