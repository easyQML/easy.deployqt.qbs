// SPDX-FileCopyrightText: © 2024 Serhii “GooRoo” Olendarenko
//
// SPDX-License-Identifier: BSD-3-Clause

import qbs.File
import qbs.FileInfo
import qbs.Process
import qbs.TextFile

import 'deployqt.js' as DeployQt
import 'qmldir-parser.js' as Qmldir

Module {
	additionalProductTypes: scanQml? ['dmg.input'] : []

	property bool scanQml: false

	property stringList plugins: []
	property stringList excludePlugins: []

	Depends { name: 'Qt.qml'; condition: scanQml }

	Group {
		name: 'Known Qt dependencies'
		files: {
			const qtModules = Object.getOwnPropertyNames(product.Qt)
			const libFiles = qtModules.reduce(function (acc, mod) {
				return acc.concat(DeployQt.getLibFilesForQtModule(product.Qt, mod))
			}, [])
			return libFiles
		}

		fileTags: []

		qbs.install: true
		qbs.installPrefix: project.installContentsPath
		qbs.installDir: project.installLibraryDir
		qbs.installSourceBase: qbs.targetOS.contains('windows')? Qt.core.binPath : Qt.core.libPath
	}

	Group {
		name: 'Qt plugins'
		prefix: product.Qt.core.pluginPath + '/'
		files: DeployQt.pluginNamesToFileNames(plugins, qbs.targetOS)
		fileTags: ['easy.deployqt.plugins']

		excludeFiles: qbs.targetOS.contains('windows')
			? qbs.buildVariant === 'debug'
				? ['**/*[!d].dll']
				: ['**/*d.dll']
			: []
	}

	Rule {
		// Copy the specified plugins into the install-root, and also scan the plugins' dynamic dependencies
		// and save them into a file

		multiplex: true

		inputs: ['easy.deployqt.plugins']

		outputFileTags: ['dmg.input', 'easy.deployqt.pluginsdeps']
		outputArtifacts: {
			const plugins = inputs['easy.deployqt.plugins']

			return plugins.map(function (plugin) {
				return {
					filePath: DeployQt.toTargetPath(
						plugin.filePath,
						product.Qt.core.pluginPath,
						project.installPluginsDir
					),
					fileTags: ['dmg.input']
				}
			}).concat([
				{
					filePath: FileInfo.joinPaths(product.buildDirectory, 'easy.deployqt', 'pluginsdeps.list'),
					fileTags: ['easy.deployqt.pluginsdeps']
				}
			])
		}

		prepare: /*(project, product, inputs, outputs, input, output, explicitlyDependsOn) =>*/ {
			var copyPlugins = new JavaScriptCommand()
			copyPlugins.silent = true
			copyPlugins.sourceCode = function () {
				const plugins = inputs['easy.deployqt.plugins']

				plugins.forEach(function (plugin) {
					const targetPath = DeployQt.toTargetPath(
						plugin.filePath,
						product.Qt.core.pluginPath,
						project.installPluginsDir
					)

					if (!File.exists(targetPath)) {
						File.copy(plugin.filePath, targetPath)
					}
				})
			}

			var scanDynamicDeps = new JavaScriptCommand()
			scanDynamicDeps.silent = true
			scanDynamicDeps.sourceCode = function () {
				const plugins = inputs['easy.deployqt.plugins']

				var deps = new Set([])

				plugins.forEach(function (plugin) {
					const dynamicLib = plugin.filePath

					const qtLibs = DeployQt.getRecursiveRuntimeDependencies(
						product.qbs.targetOS,
						product.cpp.toolchainInstallPath,
						product.qbs.targetOS.contains('windows')? product.Qt.core.binPath : product.Qt.core.libPath,
						dynamicLib,
						product.qbs.architecture
					)

					deps = DeployQt.unionSets(deps, qtLibs)
				})

				const depsList = product.qbs.targetOS.contains('darwin')?
					Array.from(deps).flatMap(function (dep) {
						return DeployQt.frameworkLibToFrameworkContents(dep)
					}) : Array.from(deps)

				var file = new TextFile(outputs['easy.deployqt.pluginsdeps'][0].filePath, TextFile.WriteOnly)
				file.write(depsList.join('\n'))
				file.close()
			}

			return [
				copyPlugins,
				scanDynamicDeps,
			]
		}
	}

	Rule {
		// Scan QML-files from QRC-files and save the list of imports into a file

		requiresInputs: false
		multiplex: true
		condition: scanQml

		inputs: ['qrc']

		Artifact {
			filePath: FileInfo.joinPaths(product.buildDirectory, 'easy.deployqt', 'qmlimports.json')
			fileTags: ['easy.deployqt.qmlimports']
		}

		prepare: /*(project, product, inputs, outputs, input, output, explicitlyDependsOn) =>*/ {
			var scanImports = new JavaScriptCommand()
			scanImports.silent = true
			scanImports.sourceCode = function () {
				const imports = DeployQt.collectQmlImports(
					product.Qt.qml.qmlImportScannerFilePath,
					(inputs['qrc'] || []),
					product.Qt.qml.qmlPath,
					product.qbs.targetOS
				)

				var file = new TextFile(output.filePath, TextFile.WriteOnly)
				file.write(JSON.stringify(imports, null, 2))
				file.close()
			}

			return [
				scanImports,
			]
		}
	}

	Rule {
		// Read the QML-imports of Qt's modules from the file, copy modules into the install-root,
		// and save the list of dynamic dependencies into another file

		multiplex: false  // the input is always one
		condition: scanQml

		inputs: ['easy.deployqt.qmlimports']

		outputFileTags: ['easy.deployqt.qmlimportsdeps', 'dmg.input']
		outputArtifacts: {
			var list = []

			const imports = DeployQt.readQmlImports(input.filePath)

			imports.forEach(function (imp) {
				const sourcePath = imp.path
				const folder = FileInfo.path(sourcePath)

				File.directoryEntries(folder, File.Files).forEach(function (entry) {
					list.push({
						filePath: DeployQt.toTargetPath(
							FileInfo.joinPaths(folder, entry),
							product.Qt.qml.qmlPath,
							project.installImportsDir
						),
						fileTags: ['dmg.input']
					})
				})
			})

			return list.concat([
				{
					filePath: FileInfo.joinPaths(product.buildDirectory, 'easy.deployqt', 'qmlimportsdeps.list'),
					fileTags: ['easy.deployqt.qmlimportsdeps']
				}
			])
		}

		prepare: /*(project, product, inputs, outputs, input, output, explicitlyDependsOn) =>*/ {
			var copyQmlModules = new JavaScriptCommand()
			copyQmlModules.silent = true
			copyQmlModules.sourceCode = function () {
				const imports = DeployQt.readQmlImports(input.filePath)

				imports.forEach(function (imp) {
					const sourcePath = imp.path
					const folder = FileInfo.path(sourcePath)

					var parser = new Qmldir.QmldirParser(FileInfo.joinPaths(folder, 'qmldir'), product.qbs.targetOS)
					parser.parse()

					var allFiles = new Set([FileInfo.joinPaths(folder, 'qmldir')])

					parser.files.forEach(function (file) {
						allFiles.add(FileInfo.joinPaths(folder, file))
					})

					parser.plugins.forEach(function (plugin) {
						if (FileInfo.isAbsolutePath(plugin))
							allFiles.add(plugin)
						else
							allFiles.add(FileInfo.joinPaths(folder, plugin))
					})

					DeployQt.collectAssets(folder).forEach(function (entry) {
						allFiles.add(entry)
					})

					allFiles.forEach(function (entry) {
						File.copy(
							entry,
							DeployQt.toTargetPath(
								entry,
								product.Qt.qml.qmlPath,
								project.installImportsDir
							)
						)
					})
				})
			}

			var scanDynamicDeps = new JavaScriptCommand()
			scanDynamicDeps.silent = true
			scanDynamicDeps.sourceCode = function () {
				const imports = DeployQt.readQmlImports(input.filePath)

				var deps = new Set([])

				for (var i in imports) {
					const dynamicLib = imports[i].path

					const qtLibs = DeployQt.getRecursiveRuntimeDependencies(
						product.qbs.targetOS,
						product.cpp.toolchainInstallPath,
						product.qbs.targetOS.contains('windows')? product.Qt.core.binPath : product.Qt.core.libPath,
						dynamicLib,
						product.qbs.architecture
					)

					const moreDeps = new Set(qtLibs)

					deps = DeployQt.unionSets(deps, moreDeps)
				}

				const depsList = product.qbs.targetOS.contains('darwin')?
					Array.from(deps).flatMap(function (dep) {
						return DeployQt.frameworkLibToFrameworkContents(dep)
					}) : Array.from(deps)

				var file = new TextFile(outputs['easy.deployqt.qmlimportsdeps'][0].filePath, TextFile.WriteOnly)
				file.write(depsList.join('\n'))
				file.close()
			}

			return [
				copyQmlModules,
				scanDynamicDeps,
			]
		}
	}

	Scanner {
		inputs: ['easy.deployqt.qmlimportsdeps', 'easy.deployqt.pluginsdeps']
		scan: /*(project, product, input, filePath) =>*/ DeployQt.readDepsFromFile(filePath)
	}

	Rule {
		// Read the list of files to install from the files and copy them into the install-root

		multiplex: true  // the input is always one

		inputs: ['easy.deployqt.qmlimportsdeps', 'easy.deployqt.pluginsdeps']

		outputFileTags: ['dmg.input', 'easy.deployqt.empty']
		outputArtifacts: {
			const installableDepsSet = DeployQt.readDepsForTags(
				inputs,
				['easy.deployqt.qmlimportsdeps', 'easy.deployqt.pluginsdeps']
			)
			const installableDeps = Array.from(installableDepsSet)

			if (installableDeps.length === 0) {
				return [
					{filePath: 'empty', fileTags: ['easy.deployqt.empty']}
				]
			}
			else {
				return installableDeps.map(function (dep) {
					return {
						filePath: DeployQt.toTargetPath(
							dep,
							product.qbs.targetOS.contains('windows')? product.Qt.core.binPath : product.Qt.core.libPath,
 							project.installLibraryDir
						),
						fileTags: ['dmg.input']
					}
				})
			}
		}

		prepare: /* (project, product, inputs, outputs, input, output, explicitlyDependsOn) => */ {
			var cmd = new JavaScriptCommand()
			cmd.silent = true
			cmd.sourceCode = function () {
				const deps = DeployQt.readDepsForTags(
					inputs,
					['easy.deployqt.qmlimportsdeps', 'easy.deployqt.pluginsdeps']
				)

				deps.forEach(function (dep) {
					const targetPath = DeployQt.toTargetPath(
						dep,
						product.qbs.targetOS.contains('windows')? product.Qt.core.binPath : product.Qt.core.libPath,
						project.installLibraryDir
					)

					if (!File.exists(targetPath)) {
						File.copy(dep, targetPath)
					}
				})
			}
			return [cmd]
		}
	}
}
