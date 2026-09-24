<?php

namespace App;

final class ValidationException extends \RuntimeException
{
    public array $errors;

    public function __construct(array $errors)
    {
        parent::__construct('Validation failed');
        $this->errors = $errors;
    }
}
