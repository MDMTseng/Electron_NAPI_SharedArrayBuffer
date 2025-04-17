#include <pybind11/embed.h>
#include <pybind11/pybind11.h>
#include <string>
#include <vector>
#include <iostream>

namespace py = pybind11;

// Global Python interpreter instance
static std::unique_ptr<py::scoped_interpreter> g_python_interpreter = nullptr;

// Function to initialize Python interpreter
bool initialize_python() {
    try {
        if (!g_python_interpreter) {
            g_python_interpreter = std::make_unique<py::scoped_interpreter>();
            
            // Add the python_script directory to Python path
            py::module_ sys = py::module_::import("sys");
            py::str script_dir = py::str("python_script");
            sys.attr("path").attr("append")(script_dir);
            
            std::cout << "Python interpreter initialized successfully" << std::endl;
        }
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize Python interpreter: " << e.what() << std::endl;
        return false;
    }
}

// Function to call Python script
std::string call_python_function(const std::string& function_name, const std::vector<std::string>& args) {
    try {
        // Import our example.py module
        py::module_ example = py::module_::import("example");
        
        // Call the specified function
        if (py::hasattr(example, function_name.c_str())) {
            py::object result = example.attr(function_name.c_str())(args);
            return py::str(result).cast<std::string>();
        } else {
            return "Error: Function '" + function_name + "' not found in Python script";
        }
    } catch (const std::exception& e) {
        return std::string("Error calling Python function: ") + e.what();
    }
}

// Function to shutdown Python interpreter
void shutdown_python() {
    g_python_interpreter.reset();
}

// Export the functions to be used from other plugins
extern "C" {
    bool python_initialize() {
        return initialize_python();
    }

    const char* python_call_function(const char* function_name, const char** args, int arg_count) {
        std::vector<std::string> arg_vector;
        for (int i = 0; i < arg_count; ++i) {
            arg_vector.push_back(args[i]);
        }
        std::string result = call_python_function(function_name, arg_vector);
        char* c_result = new char[result.length() + 1];
        strcpy(c_result, result.c_str());
        return c_result;
    }

    void python_shutdown() {
        shutdown_python();
    }

    void free_result(const char* result) {
        delete[] result;
    }
} 