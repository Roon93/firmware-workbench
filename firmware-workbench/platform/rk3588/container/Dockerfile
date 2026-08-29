# RK3588 构建容器骨架(方案 10.2)
# Phase 0 确定性构建 Spike 后锁定:基础镜像、交叉工具链版本、BSP 依赖与构建命令。
# 边界:容器只放构建/静态检查/单元测试/打包;串口、厂商 USB 刷机、VNC 保留在 Windows 主机。
FROM ubuntu:24.04 AS build-base

# 待 Phase 0 冻结:
#   ARG BSP_SDK_URL / BSP_SDK_COMMIT
#   交叉工具链 gcc-aarch64-linux-gnu 版本锁
#   mkimage / 签名 / SBOM 工具
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential git python3 python3-pip ccache \
    && rm -rf /var/lib/apt/lists/*

# 源代码采用挂载方式进入容器;构建缓存使用独立命名卷(方案 10.2)
# VOLUME /workbench/ccache

# 构建产物必须记录容器镜像 digest(方案 10.3):
#   docker images --digests printer-fw-rk3588
# build-manifest.json 由 fwctl build 在容器内生成并写回 evidence。

WORKDIR /workbench
CMD ["/bin/bash"]
