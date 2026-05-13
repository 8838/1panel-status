# 1panel-status

一个基于 1panel 的服务器状态页面。

通过调用 1Panel 的开放 API 聚合多台服务器的实时状态（CPU、内存、硬盘、负载、上下行流量等），以一个简洁的网页统一展示。

## 功能

- 多服务器集中展示，2 秒自动刷新
- 实时显示 CPU / 内存 / 硬盘 / 负载使用率
- 实时上下行速率与累计流量

## 开始

### 1. 下载仓库文件并打开文件夹

### 2. 编辑 config.json

`config.json` 用于定义要监控的服务器列表，结构如下：

```json
{
  "servers": [
    {
      "name": "vps1",
      "host": "1.1.1.1",
      "port": 12345,
      "https": false,
      "apiKey": "xxxxx"
    },
    {
      "name": "vps2",
      "host": "2.2.2.2",
      "port": 12345,
      "https": false,
      "apiKey": "xxxxx"
    },
    {
      "name": "vps3",
      "host": "3.3.3.3",
      "port": 12345,
      "https": false,
      "apiKey": "xxxxx"
    }
  ]
}
```

字段含义：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | `vps1` 是服务器显示名称，会展示在卡片左上角 |
| `host` | string | `1.1.1.1` 是被监控1Panel 所在服务器的 IP 或域名 |
| `port` | number | `12345` 是被监控1Panel 面板访问端口（即面板地址后面的端口号） |
| `https` | boolean | 被监控1Panel 面板是否启用了 HTTPS；`true` 走 https，`false` 走 http |
| `apiKey` | string | `xxxxx` 是被监控1Panel 的 API 接口密钥 |

config.json示例里有3个服务器配置，你可以根据自己服务器数量增加或减少

## 被监控1panel面板设置里的API说明

1. 被监控服务器的1panel面板里放行1panel-status所在的服务器IP，过期时间设为0，
2. 如果1panel-status监控本机的1panel，放行1panel-status的容器IP

## 构建并启动Docker Compise

```bash
docker compose up -d --build
```

## 修改config.json配置后重启

修改 `config.json` 后，需重启容器让其重新加载配置：

```bash
docker compose restart
```

或者完整停掉再启动：

```bash
docker compose down
docker compose up -d
```
