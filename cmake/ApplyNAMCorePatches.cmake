if(NOT DEFINED NAM_SOURCE_DIR)
    message(FATAL_ERROR "NAM_SOURCE_DIR was not provided")
endif()

find_program(NAM_GIT_EXECUTABLE NAMES git)
if(NOT NAM_GIT_EXECUTABLE)
    message(FATAL_ERROR "Git is required to patch NeuralAmpModelerCore")
endif()

function(nam_apply_git_patch PATCH_NAME PATCH_DESCRIPTION)
    set(PATCH_PATH "${CMAKE_CURRENT_LIST_DIR}/patches/${PATCH_NAME}")
    if(NOT EXISTS "${PATCH_PATH}")
        message(FATAL_ERROR "NeuralAmpModelerCore patch was not found: ${PATCH_PATH}")
    endif()

    execute_process(
        COMMAND "${NAM_GIT_EXECUTABLE}" -C "${NAM_SOURCE_DIR}"
                apply --check --whitespace=nowarn "${PATCH_PATH}"
        RESULT_VARIABLE PATCH_CHECK_RESULT
        OUTPUT_VARIABLE PATCH_CHECK_OUTPUT
        ERROR_VARIABLE PATCH_CHECK_ERROR
    )
    if(PATCH_CHECK_RESULT EQUAL 0)
        execute_process(
            COMMAND "${NAM_GIT_EXECUTABLE}" -C "${NAM_SOURCE_DIR}"
                    apply --whitespace=nowarn "${PATCH_PATH}"
            RESULT_VARIABLE PATCH_APPLY_RESULT
            OUTPUT_VARIABLE PATCH_APPLY_OUTPUT
            ERROR_VARIABLE PATCH_APPLY_ERROR
        )
        if(NOT PATCH_APPLY_RESULT EQUAL 0)
            message(FATAL_ERROR
                "Failed to apply ${PATCH_DESCRIPTION}:\n"
                "${PATCH_APPLY_OUTPUT}${PATCH_APPLY_ERROR}")
        endif()
        message(STATUS "Applied ${PATCH_DESCRIPTION}")
        return()
    endif()

    execute_process(
        COMMAND "${NAM_GIT_EXECUTABLE}" -C "${NAM_SOURCE_DIR}"
                apply --reverse --check --whitespace=nowarn "${PATCH_PATH}"
        RESULT_VARIABLE PATCH_REVERSE_CHECK_RESULT
        OUTPUT_VARIABLE PATCH_REVERSE_CHECK_OUTPUT
        ERROR_VARIABLE PATCH_REVERSE_CHECK_ERROR
    )
    if(PATCH_REVERSE_CHECK_RESULT EQUAL 0)
        message(STATUS "${PATCH_DESCRIPTION} is already applied")
        return()
    endif()

    message(FATAL_ERROR
        "NeuralAmpModelerCore v0.5.4 patch context changed for ${PATCH_DESCRIPTION}; "
        "refusing an unverified dependency rewrite.\n"
        "Apply check: ${PATCH_CHECK_OUTPUT}${PATCH_CHECK_ERROR}\n"
        "Reverse check: ${PATCH_REVERSE_CHECK_OUTPUT}${PATCH_REVERSE_CHECK_ERROR}")
endfunction()

set(NAM_WAVENET_MODEL "${NAM_SOURCE_DIR}/NAM/wavenet/model.cpp")
if(NOT EXISTS "${NAM_WAVENET_MODEL}")
    message(FATAL_ERROR "NeuralAmpModelerCore WaveNet source was not found: ${NAM_WAVENET_MODEL}")
endif()

file(READ "${NAM_WAVENET_MODEL}" NAM_WAVENET_SOURCE)

set(NAM_FULL_ACCUMULATOR_CLEAR
"  // Zero head inputs accumulator (first layer array)
  this->_head_inputs.setZero();
  ProcessInner(layer_inputs, condition, num_frames);")
set(NAM_ACTIVE_ACCUMULATOR_CLEAR
"  // Zero head inputs accumulator (first layer array)
  this->_head_inputs.leftCols(num_frames).setZero();
  ProcessInner(layer_inputs, condition, num_frames);")

string(FIND "${NAM_WAVENET_SOURCE}" "${NAM_ACTIVE_ACCUMULATOR_CLEAR}" NAM_PATCHED_AT)
if(NAM_PATCHED_AT GREATER_EQUAL 0)
    message(STATUS "NeuralAmpModelerCore realtime small-block patch is already applied")
else()
    string(FIND "${NAM_WAVENET_SOURCE}" "${NAM_FULL_ACCUMULATOR_CLEAR}" NAM_UNPATCHED_AT)
    if(NAM_UNPATCHED_AT LESS 0)
        message(FATAL_ERROR
            "NeuralAmpModelerCore v0.5.4 WaveNet patch context changed; "
            "refusing an unverified dependency rewrite")
    endif()

    string(REPLACE
        "${NAM_FULL_ACCUMULATOR_CLEAR}"
        "${NAM_ACTIVE_ACCUMULATOR_CLEAR}"
        NAM_WAVENET_PATCHED_SOURCE
        "${NAM_WAVENET_SOURCE}")
    file(WRITE "${NAM_WAVENET_MODEL}" "${NAM_WAVENET_PATCHED_SOURCE}")
    message(STATUS "Applied NeuralAmpModelerCore realtime small-block accumulator patch")
endif()

nam_apply_git_patch(
    "NAMCoreSlimmablePendingFastPath.patch"
    "NeuralAmpModelerCore SlimmableWavenet lock-free pending fast path")
nam_apply_git_patch(
    "NAMCoreConvNetRealtime.patch"
    "NeuralAmpModelerCore allocation-free ConvNet callback patch")
nam_apply_git_patch(
    "NAMCoreA2FastCurrentBlockMirror.patch"
    "NeuralAmpModelerCore A2 fast-path current-block tail mirror")
