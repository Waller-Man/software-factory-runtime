# Runtime API 1.0

后端、TS SDK和WebUI嵌入执行卡已实现。类型来源：packages/contracts/src/runtime.ts；SDK入口：packages/runtime-sdk。仅取消，不提供暂停／恢复。

当前Runtime／SDK本地版本0.4.0，WebUI／编排0.1.2；DSH基线仍为0.2.1-alpha.2。保留0.1／0.2／0.3业务插件的调用形状和apiVersion=1.0。

## 0.4.0 人工交互

下层新增execution.interaction.ask(request)，Promise在用户提交并持久保存答案后返回。request为{type:'select'|'text'|'mixed',question,detail?,timeoutMs?}，select／mixed还需options:[{value,label,description?}]，text／mixed可带placeholder。选项value唯一、最多30项；文本非空且最多16384字符。select只返回value，text只返回text，mixed返回value?／text?且至少一项；均含interactionId及type。严格拒绝其他模式字段和未知选项。同一Run同时只有一个未决问题，业务必须await后继续。

默认人工等待24小时，逐次timeoutMs可设1毫秒至7天。等待期间暂停任务执行预算而非取消信号，模型请求时限不变；超时报INTERACTION_TIMEOUT并失败，取消／停用结束等待，不自动代选。浏览器刷新不取消问题，服务重启按既有规则interrupted，遗留pending标记cancelled；不恢复算法栈，不支持附件上传。

RunRecord可选增加interactions、pendingInteraction、sourceSessionId、executionSessionId；RunStatus保持原枚举，pending卡片显示“等待用户”。记录持久保存在run.json，RunEvent新增interaction类型，状态pending／answered／cancelled／expired。来源由Host对象上下文绑定：bindRunSource(executionAgent,sourceAgent)核对真实会话和同一工作区，返回临时绑定释放函数；任务启动固定来源，不接受LLM在RunRequest任意填写身份。编排只在审核确认后根据服务端记录调用此Host方法，业务仍通过正常Tool链执行。

上层增加两个Remote：listInteractions(runtimeSession,{runId},signal?)返回InteractionRecord[]；answerInteraction(runtimeSession,{runId,interactionId,answer},uiToken,signal?)返回{interactionId,status:'answered'}。后者要求来源会话路由、DSH认证Remote调用以及同peer短期网页授权，无对应Tool。授权由同源POST /api/sf-runtime/ui-session、JSON空对象取得，使用DSH connection.admit验证；20分钟有效，撤销于服务停用，不进入日志、聊天或任务文件。模型网关任务令牌不能代答。问题按ID只结算一次，提交和取消均先保存再释放等待。

## 0.3.0 模型网关与记录

| protocol | HTTP路径 | getConnection返回的baseUrl后缀 |
| --- | --- | --- |
| openai-completions | POST /sf-runtime/model/v1/chat/completions | /sf-runtime/model/v1 |
| openai-responses | POST /sf-runtime/model/v1/responses | /sf-runtime/model/v1 |
| anthropic-messages | POST /sf-runtime/model/v1/messages | /sf-runtime/model |

机器请求由任务临时令牌认证，OpenAI使用Bearer，Messages也接受x-api-key；不经过浏览器/api认证，拒绝带Origin的浏览器请求。真实地址和API Key从选定DSH连接读取，不接受调用者URL。连接快照在任务启动时固定（未声明协议的旧Tool在首次getConnection时解析），Key通过凭据服务逐次读取。临时令牌只在活跃Run期间有效，终态、取消、服务停用即撤销，不落盘。

工具通过modelProtocols／getConnection指定请求协议，AI／用户只选服务商、模型与思考强度。Runtime 0.3.1在所选连接的已确认入口中路由，不再比较“工具协议必须等于DSH自身默认协议”；保持入站与上游请求同协议，不转换正文。DeepSeek官方标准根目录、/v1、/anthropic、/anthropic/v1对应Chat=/chat/completions、Responses=/responses、Messages=/anthropic/v1/messages；OpenAI官方根目录或/v1对应Chat=/v1/chat/completions、Responses=/v1/responses。入口表按精确origin和标准路径匹配，未登记的自定义反代保留原协议／地址，不修改域名或猜测替代路径。启动时核对业务声明的协议至少有一项可用，实际getConnection也须属于声明集合；SDK形状不变。

body.model必须等于上层模型，思考字段按DSH目录及目标协议映射注入，冲突拒绝，不关闭推理。DeepSeek Chat按上层强度注入thinking和reasoning_effort，Messages使用thinking与output_config，Responses使用reasoning.effort；JSON及其他业务字段保持。三种协议外、账号登录授权和签名认证不支持，旧model.call仍走宿主适配器。目录默认值复用pi-ai@1.0.2；旧Claude预算式思考需max_tokens容纳预算。

JSON格式、top_p、top_k等其余字段保留，由提供方判断能力；JSON及SSE响应保持原协议。只开放上表三个POST端点，不含Files上传、模型目录、Responses查询／删除和后台任务轮询。单次模型调用默认480000ms（8分钟），整体任务默认3600000ms（1小时），请求和响应各限64MiB；不自动重试，调用端自行遵守signal。

时限配置通过DSH插件详情页的原生configForms／settings保存，界面填写分钟、存储整数毫秒，范围1000～7200000ms。Config使用volatile值，每个Run在启动时固定两项时限，保存不重启服务、不影响在途任务；显式已有值不覆盖，RunRequest.timeoutMs仍优先。网关和旧model.call均使用所属任务的模型时限。无需.env。

getRun／waitRun中的可选modelCalls仅含摘要：requestId、protocol（旧call为sdk）、model、stage?、status、startedAt、finishedAt?、durationMs?、usage?、error?。详情另含request、response?及旧SDK的transcript?；认证Remote需真实会话及相同授权工作区，不能直接提交文件路径。文件为<workspace>/outputs/runs/<runId>/logs/model-calls/<requestId>.json。认证头、真实与临时Key不记录，内联图片数据省略；业务正文仍按任务材料管理。

新HTTP请求不创建DSH会话；旧model.call只使用隔离内存Session，转录归任务目录，不调用宿主会话持久化服务。历史侧栏会话不自动整理或删除。WebUI增加折叠记录详情；编排原生模型和思考强度选择保持，确认执行前校验声明的modelProtocols。旧历史任务无modelCalls时照常读取。

## 上层：12个接口（7个 Tool、12个 Remote）

Tool与Remote复用同一服务。返回信封为`{ok:true,data}`或`{ok:false,error:{code,message}}`。Remote客户端外层还有DSH标准RemoteResult，先检查传输成功，再检查本服务ok。watchRun每条消息也是本服务信封。

| Service／Remote方法 | 编排Tool | 输入request | data输出 |
| --- | --- | --- | --- |
| getToolContract | sf_runtime_get_tool_contract | `{toolId,model?}` | `{toolId,description,inputSchema,supportsRun:true,modelProtocols?}`；指定model时预检网关协议／凭据／思考映射 |
| runTool | sf_runtime_run_tool | `{toolId,input,model?,timeoutMs?}` | `{runId,status:'queued'}` |
| getRun | sf_runtime_get_run | `{runId}` | RunRecord |
| listRuns | sf_runtime_list_runs | `{toolId?,status?,limit?,offset?}` | `{items:RunSummary[],total}` |
| waitRun | sf_runtime_wait_run | `{runId,afterSeq?,waitMs?}` | `{run,events,lastSeq}` |
| cancelRun | sf_runtime_cancel_run | `{runId}` | `{runId,status}` |
| watchRun | 无永久等待Tool | `{runId,afterSeq?}` | RunEvent流 |
| getArtifact | sf_runtime_get_artifact | `{runId,artifactId}` | Artifact及认证downloadUrl |
| listModelCalls | 无 | `{runId}` | `ModelCallSummary[]` |
| getModelCall | 无 | `{runId,requestId}` | `ModelCallRecord` |
| listInteractions | 无 | `{runId}` | `InteractionRecord[]` |
| answerInteraction | 用户网页专用，无Tool | `{runId,interactionId,answer}`，另需uiToken | `{interactionId,status:'answered'}` |

Remote命名空间sfRuntime。Host方法第一参数runtimeSession由Typert lookup解析，客户端传入`runtimeSessionId`作为当前真实会话路由，第二参数request为上表对象；signal由宿主传输。RunRequest不接受身份、工作区路径、凭据或任意执行函数。

列表limit默认20、最大100，offset默认0，按创建时间降序。waitMs默认15000、最大30000；有新事件、终态或等待到期返回。afterSeq省略表示从当前序号开始等待；watch默认0，回放已保存事件。重新连接提供上次lastSeq。等待到期不取消任务。

状态：queued、running、cancelling、completed、failed、cancelled、interrupted。致命错误不能被下级completed覆盖。文件查看／下载仍须同一授权工作区；downloadUrl使用DSH认证且携带会话路由，不能匿名访问或传任意文件路径。

## 下层：11项

| 方法／回调 | 输入 | 输出 |
| --- | --- | --- |
| registerRunTool(ctx,definition) | `{toolId,description,inputSchema,execute,modelProtocols?}` | 生命周期释放函数 |
| execute(input,execution) | 真实业务输入及宿主绑定ExecutionContext | `Promise<{text?,files?:artifactId[]}>` |
| reportStatus | status、message? | Promise<void> |
| reportProgress | stage、stageName、progress?、message? | Promise<void> |
| log | message、stage? | Promise<void> |
| reportIssue | level、message、stage?、code?、fatal? | Promise<void> |
| addArtifact | kind、name、relativePath、mime | Promise<Artifact> |
| model.call | `{messages:[{role,content}],temperature?,maxTokens?,stop?}`；user的content可为字符串或text／image_url数组 | `Promise<{text,usage?}>` |
| model.getConnection | `{protocol:'openai-completions'|'openai-responses'|'anthropic-messages'}` | `Promise<{baseUrl,apiKey,model,protocol}>`；apiKey为短期任务令牌 |
| registerCleanup | 清理回调 | void |
| interaction.ask | `{type,question,options?,placeholder?,detail?,timeoutMs?}`，按类型严格校验 | `Promise<{interactionId,type,value?,text?}>`，按类型保证有效答案 |

ExecutionContext含runId、outputDirectory、signal、model.selection及上表方法。上下文仅交给真实正常Tool链内的本次业务执行，不是LLM参数。输入Schema使用宿主实际支持的JSON Schema子集，不兼容旧Runtime。

model可选。传入则固定指定模型；省略保存来源会话已有模型；没有模型也可以执行纯算法。声明modelProtocols的Tool须先选模型，其他Tool在调用模型时才报MODEL_REQUIRED。SDK不向每次请求开放换模型或真实上游地址、API Key；getConnection提供的是临时网关连接。旧model.call用量保留DSH缓存计数口径，HTTP用量保留上游字段，未知值省略。

ModelRef为{provider,model,reasoningEffort?}。reasoningEffort是DSH原生模型目录给出的不透明ID；省略沿用宿主默认语义，指定时启动校验其真实元数据，并在任务记录、模型请求及隔离会话header中保留。此可选字段向后兼容，不要求业务插件改写算法或SDK调用。

SDK／Runtime 0.2.0为ModelRequest增加temperature?:number（有限数0～2）、maxTokens?:number（正整数）、stop?:string[]（至少一项且每项长度>0，原样保留）。这些字段由算法每次调用提供，不进入ModelRef／RunRequest／前端配置；省略时不补默认值，不从上次调用继承，不改变原0.1.0行为。temperature=0有效；未知字段继续由strict校验拒绝。参数在DSH prepareCall时提供，prepared.config同时用于隔离会话request/header与流式请求；日志JSON额外的requestedControls只在显式设置时保存。达到输出长度上限仍报MODEL_OUTPUT_TRUNCATED，不改返回结构。

兼容方向：旧SDK 0.1.0插件可直接运行于新版Runtime；新参数要求Runtime>=0.2.0，旧Runtime会拒绝新字段，不静默降级。API记录版本仍为1.0，无任务迁移；现有Tool／Remote接口及卡片展示不变。底层适配器／模型另有约束：本地DeepSeek适配器转发三项，thinking模式忽略温度；本地llm-pi-ai路径未转发stop。不自动切换模型或关闭推理，不承诺任意第三方路由参数均生效。

ModelRequest采用API风格：system／assistant的content为字符串；user的content为字符串或`[{type:'text',text},{type:'image_url',image_url:{url}}]`，可包含多张图片。url为公网HTTP(S)图片地址或Base64 Data URL，例如`data:image/png;base64,...`，支持PNG、JPEG、GIF、WebP。本地文件由业务代码读取后编码，不接受任意本地路径、厂商file_id或普通文档块；不新增独立上传接口。

图片经DSH附件服务校验／持久化，转换成原生image内容块；模型必须在本次prepared路由元数据声明image能力，否则MODEL_IMAGE_UNSUPPORTED。缺少附件服务报IMAGE_SERVICE_UNAVAILABLE。URL匿名下载遵循宿主代理策略，校验公网目的地、重定向与大小并响应取消；不向图片地址发送DSH凭据。正文文本总量不超过1MiB，图片大小／数量使用DSH附件及模型限制。隔离模型日志记录规范化附件引用，不重复保存内联Base64；历史由开发者逐次通过messages传入，不自动维护会话。普通文档先由业务代码解析为文本或图片。

Artifact：artifactId、kind、name、relativePath、mime、size、downloadUrl?。BusinessResult的files只引用当前任务已登记的final文件；RunResult为`{text?,files:Artifact[]}`。RunRecord额外含model?、logs、issues、artifacts、result?、lastSeq。RunEvent为`{runId,seq,type,data,time}`，type是status／progress／log／issue／artifact／result。

getRun返回的RunRecord另含intermediateDirectories（数组项为{path,fileCount}）：Runtime按已登记intermediate文件所属的intermediate/和snapshots/分别给出实际目录与登记文件数；空目录不展示。path由Runtime在同一工作区校验，经过目录链接或越界路径会被拒绝，不接受前端传入任意路径。目录引用在读取时生成，不写入业务输入或要求SDK上报。文件索引与逐文件getArtifact保留用于追溯；卡片只给final文件下载，中间文件不逐个列出。目录按钮通过明确注入的DSH remote.session.openWorkspacePath打开，失败、取消和恢复记录也保留目录入口。onFinished.files仅含final文件。SDK的addArtifact与BusinessResult签名不变，现有业务插件无须修改或重新安装SDK。

交付展示以result.files为唯一清单：artifacts中的final也可能是ZIP内部组成文件，不自动追加到下载列表或onFinished.files。无result时不展示交付下载；中间目录入口独立保留。不通过改写业务插件的kind分类控制展示。

SDK登记表是可用入口的唯一来源：业务插件通过registerRunTool登记后自动可用，停用／卸载自动撤销；读取契约和启动仍检查真实Tool身份及当前会话可见性，不扫描HugeGraph补造入口。allowedToolIds配置和校验已移除；SDK、Tool与Remote参数不变，现有业务插件无须重新开发。SDK登记不会写HugeGraph。普通错误和失败材料保存到任务目录。用户实际profile安装、真实模型及PTC Remote直接启动未验证，宿主权限限制不会绕过。
