<?php

namespace App;

final class Validator
{
    /**
     * Requires each key in $fields to be a non-empty scalar in $data.
     * Throws ValidationException listing all missing/invalid fields.
     */
    public static function required(array $data, array $fields): void
    {
        $errors = [];
        foreach ($fields as $field) {
            if (!array_key_exists($field, $data) || $data[$field] === '' || $data[$field] === null) {
                $errors[$field] = 'required';
            }
        }
        if ($errors) {
            throw new ValidationException($errors);
        }
    }

    public static function email(string $email): bool
    {
        return filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
    }

    public static function oneOf(mixed $value, array $allowed): bool
    {
        return in_array($value, $allowed, true);
    }
}
