# Runtime API 1.0

后端、TS SDK和WebUI嵌入执行卡已实现。类型来源：packages/contracts/src/runtime.ts；SDK入口：packages/runtime-sdk。仅取消，不提供暂停／恢复。

## 上层：8个接口

Tool与Remote复用同一服务。返回信封为`{ok:true,data}`或`{ok:false,error:{code,message}}`。Remote客户端外层还有DSH标准RemoteResult，先检查传输成功，再检查本服务ok。watchRun每条消息也是本服务信封。

| Service／Remote方法 | 编排Tool | 输入request | data输出 |
| --- | --- | --- | --- |
| getToolContract | sf_runtime_get_tool_contract | `{toolId}` | `{toolId,description,inputSchema,supportsRun:true}` |
| runTool | sf_runtime_run_tool | `{toolId,input,model?,timeoutMs?}` | `{runId,status:'queued'}` |
| getRun | sf_runtime_get_run | `{runId}` | RunRecord |
| listRuns | sf_runtime_list_runs | `{toolId?,status?,limit?,offset?}` | `{items:RunSummary[],total}` |
| waitRun | sf_runtime_wait_run | `{runId,afterSeq?,waitMs?}` | `{run,events,lastSeq}` |
| cancelRun | sf_runtime_cancel_run | `{runId}` | `{runId,status}` |
| watchRun | 无永久等待Tool | `{runId,afterSeq?}` | RunEvent流 |
| getArtifact | sf_runtime_get_artifact | `{runId,artifactId}` | Artifact及认证downloadUrl |

Remote命名空间sfRuntime。Host方法第一参数runtimeSession由Typert lookup解析，客户端传入`runtimeSessionId`作为当前真实会话路由，第二参数request为上表对象；signal由宿主传输。RunRequest不接受身份、工作区路径、凭据或任意执行函数。

列表limit默认20、最大100，offset默认0，按创建时间降序。waitMs默认15000、最大30000；有新事件、终态或等待到期返回。afterSeq省略表示从当前序号开始等待；watch默认0，回放已保存事件。重新连接提供上次lastSeq。等待到期不取消任务。

状态：queued、running、cancelling、completed、failed、cancelled、interrupted。致命错误不能被下级completed覆盖。文件查看／下载仍须同一授权工作区；downloadUrl使用DSH认证且携带会话路由，不能匿名访问或传任意文件路径。

## 下层：9项

| 方法／回调 | 输入 | 输出 |
| --- | --- | --- |
| registerRunTool(ctx,definition) | `{toolId,description,inputSchema,execute}` | 生命周期释放函数 |
| execute(input,execution) | 真实业务输入及宿主绑定ExecutionContext | `Promise<{text?,files?:artifactId[]}>` |
| reportStatus | status、message? | Promise<void> |
| reportProgress | stage、stageName、progress?、message? | Promise<void> |
| log | message、stage? | Promise<void> |
| reportIssue | level、message、stage?、code?、fatal? | Promise<void> |
| addArtifact | kind、name、relativePath、mime | Promise<Artifact> |
| model.call | `{messages:[{role,content}]}`；user的content可为字符串或text／image_url数组 | `Promise<{text,usage?}>` |
| registerCleanup | 清理回调 | void |

ExecutionContext含runId、outputDirectory、signal、model.selection及上表方法。上下文仅交给真实正常Tool链内的本次业务执行，不是LLM参数。输入Schema使用宿主实际支持的JSON Schema子集，不兼容旧Runtime。

model可选。传入则固定指定模型；省略保存来源会话已有模型；没有模型也可以执行纯算法，调用model.call时才明确报MODEL_REQUIRED。SDK不向每次请求开放换模型、API Key或服务地址。模型用量保留DSH缓存计数口径，未知值省略。

ModelRef为{provider,model,reasoningEffort?}。reasoningEffort是DSH原生模型目录给出的不透明ID；省略沿用宿主默认语义，指定时启动校验其真实元数据，并在任务记录、模型请求及隔离会话header中保留。此可选字段向后兼容，不要求业务插件改写算法或SDK调用。

ModelRequest采用API风格：system／assistant的content为字符串；user的content为字符串或`[{type:'text',text},{type:'image_url',image_url:{url}}]`，可包含多张图片。url为公网HTTP(S)图片地址或Base64 Data URL，例如`data:image/png;base64,...`，支持PNG、JPEG、GIF、WebP。本地文件由业务代码读取后编码，不接受任意本地路径、厂商file_id或普通文档块；不新增独立上传接口。

图片经DSH附件服务校验／持久化，转换成原生image内容块；模型必须在本次prepared路由元数据声明image能力，否则MODEL_IMAGE_UNSUPPORTED。缺少附件服务报IMAGE_SERVICE_UNAVAILABLE。URL匿名下载遵循宿主代理策略，校验公网目的地、重定向与大小并响应取消；不向图片地址发送DSH凭据。正文文本总量不超过1MiB，图片大小／数量使用DSH附件及模型限制。隔离模型日志记录规范化附件引用，不重复保存内联Base64；历史由开发者逐次通过messages传入，不自动维护会话。普通文档先由业务代码解析为文本或图片。

Artifact：artifactId、kind、name、relativePath、mime、size、downloadUrl?。BusinessResult的files只引用当前任务已登记的final文件；RunResult为`{text?,files:Artifact[]}`。RunRecord额外含model?、logs、issues、artifacts、result?、lastSeq。RunEvent为`{runId,seq,type,data,time}`，type是status／progress／log／issue／artifact／result。

getRun返回的RunRecord另含intermediateDirectories（数组项为{path,fileCount}）：Runtime按已登记intermediate文件所属的intermediate/和snapshots/分别给出实际目录与登记文件数；空目录不展示。path由Runtime在同一工作区校验，经过目录链接或越界路径会被拒绝，不接受前端传入任意路径。目录引用在读取时生成，不写入业务输入或要求SDK上报。文件索引与逐文件getArtifact保留用于追溯；卡片只给final文件下载，中间文件不逐个列出。目录按钮通过明确注入的DSH remote.session.openWorkspacePath打开，失败、取消和恢复记录也保留目录入口。onFinished.files仅含final文件。SDK的addArtifact与BusinessResult签名不变，现有业务插件无须修改或重新安装SDK。

交付展示以result.files为唯一清单：artifacts中的final也可能是ZIP内部组成文件，不自动追加到下载列表或onFinished.files。无result时不展示交付下载；中间目录入口独立保留。不通过改写业务插件的kind分类控制展示。

SDK登记表是可用入口的唯一来源：业务插件通过registerRunTool登记后自动可用，停用／卸载自动撤销；读取契约和启动仍检查真实Tool身份及当前会话可见性，不扫描HugeGraph补造入口。allowedToolIds配置和校验已移除；SDK、Tool与Remote参数不变，现有业务插件无须重新开发。SDK登记不会写HugeGraph。普通错误和失败材料保存到任务目录。用户实际profile安装、真实模型及PTC Remote直接启动未验证，宿主权限限制不会绕过。
